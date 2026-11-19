/**
 * APK files: reads package / version from the APK's own manifest, stores the file under data\apks.
 */

'use strict';

const fs        = require( 'fs' );
const path      = require( 'path' );
const crypto    = require( 'crypto' );
const ApkReader = require( '@devicefarmer/adbkit-apkreader' );
const config    = require( '../config/config' );

fs.mkdirSync( config.paths.apks, { recursive: true } );

/**
 * @description SHA-256 of a file
 * @param {string} file - Path
 * @returns {Promise<string>} Hex
 */
function sha256File( file ) {
    return new Promise( function( resolve, reject ) {
        const hash = crypto.createHash( 'sha256' );
        fs.createReadStream( file ).on( 'error', reject ).on( 'data', ( d ) => hash.update( d ) ).on( 'end', () => resolve( hash.digest( 'hex' ) ) );
    } );
}

/**
 * @description Reads an APK's package name, version and label
 * @param {string} file - Path of the uploaded file
 * @returns {Promise<object>} { package, version_code, version_name, label }
 * @throws {Error} When the file is not a readable APK
 */
async function readManifest( file ) {
    let manifest;
    try {
        const reader = await ApkReader.open( file );
        manifest = await reader.readManifest();
    } catch ( e ) {
        throw new Error( 'This file is not a valid APK' );
    }
    const pkg  = String( manifest.package || '' );
    const code = Number( manifest.versionCode );
    if ( !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test( pkg ) || !Number.isInteger( code ) || code < 1 ) {
        throw new Error( 'The APK has no valid package name or version code' );
    }
    // The label is often a resource reference (a number) that cannot be resolved without the resource table
    let label = manifest.application && typeof manifest.application.label === 'string' ? manifest.application.label : '';
    if ( /^resourceId:/.test( label ) ) {
        label = '';
    }
    return {
        package:      pkg,
        version_code: code,
        version_name: String( manifest.versionName || '' ).slice( 0, 50 ),
        label:        label.slice( 0, 100 )
    };
}

/**
 * @description Moves an uploaded APK into data\apks under a name made of package + version + hash
 * @param {string} tmpFile - Uploaded file
 * @param {object} info - From readManifest
 * @param {string} sha256 - Hex
 * @returns {string} Stored file name (inside data\apks)
 */
function store( tmpFile, info, sha256 ) {
    const name = info.package + '_' + info.version_code + '_' + sha256.slice( 0, 12 ) + '.apk';
    fs.renameSync( tmpFile, path.join( config.paths.apks, name ) );
    return name;
}

/**
 * @description Full path of a stored APK
 * @param {string} fileName - apks.file_name
 * @returns {string}
 */
function pathOf( fileName ) {
    return path.join( config.paths.apks, path.basename( fileName ) );
}

module.exports = { sha256File, readManifest, store, pathOf };
