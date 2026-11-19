/**
 * Backup install over network ADB from this PC, for a box that cannot install an update itself.
 * Needs adb.exe (Android platform-tools) on this PC - in PATH or set on the Settings page - and network ADB
 * (port 5555) on the box. Commands run with execFile (no shell), so no value is ever parsed by a shell.
 */

'use strict';

const fs           = require( 'fs' );
const { execFile } = require( 'child_process' );
const config       = require( '../config/config' );
const { setting }  = require( './db' );

/**
 * @description adb executable: the path set on the Settings page, else "adb" from PATH
 * @returns {string}
 */
function adbPath() {
    const custom = setting( 'adb_path' );
    return custom && fs.existsSync( custom ) ? custom : 'adb';
}

/**
 * @description Runs adb with arguments
 * @param {Array<string>} args - Arguments
 * @param {number} timeoutMs - Time limit
 * @returns {Promise<string>} Output (stdout + stderr)
 */
function run( args, timeoutMs ) {
    return new Promise( function( resolve ) {
        execFile( adbPath(), args, { timeout: timeoutMs, windowsHide: true }, function( err, stdout, stderr ) {
            const out = ( String( stdout || '' ) + String( stderr || '' ) ).trim();
            if ( err && err.code === 'ENOENT' ) {
                resolve( 'adb was not found on this PC' );
                return;
            }
            resolve( out || ( err ? err.message : '' ) );
        } );
    } );
}

/**
 * @description adb version line, to show on the Settings page
 * @returns {Promise<string>}
 */
async function version() {
    const out = await run( [ 'version' ], 10000 );
    return out.split( /\r?\n/ )[ 0 ];
}

/**
 * @description Installs an APK on a box over network ADB
 * @param {string} ip - Box IPv4
 * @param {string} apkFile - Full path of the APK
 * @returns {Promise<object>} { ok, message }
 */
async function install( ip, apkFile ) {
    if ( !/^\d{1,3}(\.\d{1,3}){3}$/.test( ip ) ) {
        return { ok: false, message: 'The box has no valid IP' };
    }
    const target = ip + ':' + config.adbPort;
    const conn   = await run( [ 'connect', target ], 15000 );
    if ( !/connected to/i.test( conn ) ) {
        return { ok: false, message: 'ADB could not connect: ' + conn.slice( 0, 200 ) };
    }
    const out = await run( [ '-s', target, 'install', '-r', '-d', apkFile ], 300000 );
    await run( [ 'disconnect', target ], 10000 );
    return /^Success/m.test( out ) ? { ok: true, message: '' } : { ok: false, message: out.slice( -300 ) || 'Install failed' };
}

module.exports = { version, install };
