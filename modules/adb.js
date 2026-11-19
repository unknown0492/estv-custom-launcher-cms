/**
 * Backup install over network ADB from this PC, for a box that cannot install an update itself.
 * Needs adb.exe (Android platform-tools) on this PC - install-cms.bat installs it with Chocolatey (1.0.3) - and
 * network ADB (port 5555) on the box. Commands run with execFile (no shell), so no value is ever parsed by a shell.
 */

'use strict';

const fs           = require( 'fs' );
const path         = require( 'path' );
const { execFile } = require( 'child_process' );
const config       = require( '../config/config' );
const { setting }  = require( './db' );

/**
 * @description Usual places of adb.exe on Windows. Looked at directly because PM2 keeps the PATH it had when it
 *              started, so an adb installed afterwards (e.g. by install-cms.bat) is not on the CMS's PATH yet.
 * @returns {Array<string>}
 */
function knownAdbPaths() {
    const env = process.env;
    return [
        env.ProgramData  && path.join( env.ProgramData, 'chocolatey', 'bin', 'adb.exe' ),                               // Chocolatey shim
        env.ProgramData  && path.join( env.ProgramData, 'chocolatey', 'lib', 'adb', 'tools', 'platform-tools', 'adb.exe' ),
        env.LOCALAPPDATA && path.join( env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe' ),               // Android Studio
        'C:\\platform-tools\\adb.exe'
    ].filter( Boolean );
}

/**
 * @description adb executable: the path set on the Settings page, else a usual place, else "adb" from PATH
 * @returns {string}
 */
function adbPath() {
    const custom = setting( 'adb_path' );
    if ( custom && fs.existsSync( custom ) ) {
        return custom;
    }
    return knownAdbPaths().find( ( p ) => fs.existsSync( p ) ) || 'adb';
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
 * @description adb version line and the adb.exe used, to show on the Settings page
 * @returns {Promise<string>}
 */
async function version() {
    const out = await run( [ 'version' ], 10000 );
    const exe = adbPath();
    return out.split( /\r?\n/ )[ 0 ] + ( exe === 'adb' ? '' : ' (' + exe + ')' );
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
