/**
 * Box API (docs/box-protocol.md): check-in every 5 minutes, wallpaper and APK downloads.
 * Open on the hotel LAN, like the boxes' other services; it never changes anything but the box's own rows.
 */

'use strict';

const fs      = require( 'fs' );
const path    = require( 'path' );
const express = require( 'express' );
const config  = require( '../config/config' );
const apk     = require( '../modules/apk' );
const { db, setting, displayTarget } = require( '../modules/db' );

const router = express.Router();

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

const upsertBox = db.prepare( `
    INSERT INTO boxes ( mac, box_name, ip, launcher_version_code, launcher_version_name, buttons_source, buttons_rev, firmware, android, first_seen, last_seen )
    VALUES ( @mac, @box_name, @ip, @lvc, @lvn, @buttons_source, @buttons_rev, @firmware, @android, @now, @now )
    ON CONFLICT( mac ) DO UPDATE SET box_name = excluded.box_name, ip = excluded.ip,
        launcher_version_code = excluded.launcher_version_code, launcher_version_name = excluded.launcher_version_name,
        buttons_source = excluded.buttons_source, buttons_rev = excluded.buttons_rev,
        firmware = excluded.firmware, android = excluded.android, last_seen = excluded.last_seen` );
const upsertApp = db.prepare( `
    INSERT INTO box_apps ( mac, package, version_code, version_name, updated_on ) VALUES ( ?, ?, ?, ?, ? )
    ON CONFLICT( mac, package ) DO UPDATE SET version_code = excluded.version_code, version_name = excluded.version_name, updated_on = excluded.updated_on` );
const upsertResult = db.prepare( `
    INSERT INTO box_apk_results ( mac, apk_id, state, message, via, updated_on ) VALUES ( ?, ?, ?, ?, 'box', ? )
    ON CONFLICT( mac, apk_id ) DO UPDATE SET state = excluded.state, message = excluded.message, via = 'box', updated_on = excluded.updated_on` );
const getBox      = db.prepare( 'SELECT * FROM boxes WHERE mac = ?' );
const setDisplay  = db.prepare( 'UPDATE boxes SET display_scale = ?, display_mode = ?, display_modes = ? WHERE mac = ?' );
const apkExists   = db.prepare( 'SELECT 1 FROM apks WHERE id = ?' );
const listButtons = db.prepare( 'SELECT name, package, activity FROM buttons ORDER BY sort, id' );
// Newest active APK per package (highest version code, then newest upload)
const offeredApks = db.prepare( `
    SELECT a.id, a.package, a.version_code, a.version_name, a.sha256, a.size FROM apks a
    WHERE a.active = 1 AND a.id = ( SELECT b.id FROM apks b WHERE b.package = a.package AND b.active = 1
                                    ORDER BY b.version_code DESC, b.uploaded_on DESC LIMIT 1 )
    ORDER BY a.package` );

/**
 * @description Text from a request field, trimmed and cut to a length
 * @param {*} v - Value
 * @param {number} max - Longest length
 * @returns {string}
 */
function text( v, max ) {
    return ( typeof v === 'string' || typeof v === 'number' ) ? String( v ).trim().slice( 0, max ) : '';
}

/**
 * @description Whole number from a request field, within limits
 * @param {*} v - Value
 * @param {number} max - Highest value
 * @returns {number} 0 when not a whole number in range
 */
function int( v, max ) {
    const n = Number( v );
    return Number.isInteger( n ) && n >= 0 && n <= max ? n : 0;
}

/**
 * @description POST /api/box/checkin
 */
router.post( '/checkin', express.json( { limit: '64kb' } ), function( req, res ) {
    const b   = req.body || {};
    const mac = text( b.mac, 17 ).toUpperCase().replace( /-/g, ':' );
    if ( !MAC_RE.test( mac ) ) {
        res.status( 400 ).json( { ok: false, error: 'mac is missing or invalid' } );
        return;
    }
    const propertyId = setting( 'property_id' );
    const now        = Date.now();
    const launcher   = b.launcher && typeof b.launcher === 'object' ? b.launcher : null;
    const old        = getBox.get( mac ) || {};
    // A field the box did not send keeps its stored value
    const has        = ( k ) => Object.prototype.hasOwnProperty.call( b, k );
    const ip         = text( b.ip, 45 ) || old.ip || String( req.socket.remoteAddress || '' ).replace( /^::ffff:/, '' );

    db.transaction( function() {
        upsertBox.run( {
            mac:            mac,
            box_name:       has( 'box_name' ) ? text( b.box_name, 60 ) : ( old.box_name || '' ),
            ip:             ip,
            lvc:            launcher ? int( launcher.version_code, 2147483647 ) : ( old.launcher_version_code || 0 ),
            lvn:            launcher ? text( launcher.version_name, 50 ) : ( old.launcher_version_name || '' ),
            buttons_source: has( 'buttons_source' ) ? ( b.buttons_source === 'local' ? 'local' : 'cms' ) : ( old.buttons_source || 'cms' ),
            buttons_rev:    has( 'buttons_rev' ) ? int( b.buttons_rev, 2147483647 ) : ( old.buttons_rev || 0 ),
            firmware:       has( 'firmware' ) ? text( b.firmware, 100 ) : ( old.firmware || '' ),
            android:        has( 'android' ) ? text( b.android, 20 ) : ( old.android || '' ),
            now:            now
        } );
        ( Array.isArray( b.apps ) ? b.apps.slice( 0, 50 ) : [] ).forEach( function( a ) {
            const pkg = a && text( a.package, 150 );
            if ( pkg && PKG_RE.test( pkg ) ) {
                upsertApp.run( mac, pkg, int( a.version_code, 2147483647 ), text( a.version_name, 50 ), now );
            }
        } );
        ( Array.isArray( b.apk_results ) ? b.apk_results.slice( 0, 50 ) : [] ).forEach( function( r ) {
            const id    = r && int( r.apk_id, 2147483647 );
            const state = r && ( r.state === 'installed' || r.state === 'failed' ) ? r.state : '';
            if ( id && state && apkExists.get( id ) ) {
                upsertResult.run( mac, id, state, text( r.message, 300 ), now );
            }
        } );
        // 1.0.2: screen size / resolution as the box has them now (absent on a box without the display API)
        if ( b.display && typeof b.display === 'object' ) {
            const scale = Number( b.display.scale );
            const modes = ( Array.isArray( b.display.modes ) ? b.display.modes : [] )
                .map( ( m ) => text( m, 40 ) ).filter( ( m ) => m !== '' ).slice( 0, 60 );
            setDisplay.run( Number.isInteger( scale ) && scale >= 0 && scale <= 100 ? scale : -1,
                            text( b.display.mode, 40 ), JSON.stringify( modes ), mac );
        }
    } )();

    const wallHash = setting( 'wallpaper_hash' );
    res.json( {
        ok:            true,
        protocol:      1,
        property_id:   propertyId,
        property_name: setting( 'property_name' ),
        interval_sec:  config.boxes.intervalSec,
        wallpaper:     wallHash ? { hash: wallHash, url: '/api/box/wallpaper/' + wallHash } : null,
        buttons:       { rev: Number( setting( 'buttons_rev', '0' ) ), list: listButtons.all() },
        display:       displayTarget( getBox.get( mac ) ),
        apks:          offeredApks.all().map( ( a ) => ( {
            apk_id:       a.id,
            package:      a.package,
            version_code: a.version_code,
            version_name: a.version_name,
            sha256:       a.sha256,
            size:         a.size,
            url:          '/api/box/apk/' + a.id
        } ) )
    } );
} );

/**
 * @description GET /api/box/wallpaper/:hash - the current wallpaper (404 once replaced)
 */
router.get( '/wallpaper/:hash', function( req, res ) {
    const hash = setting( 'wallpaper_hash' );
    const file = setting( 'wallpaper_file' );
    if ( !hash || req.params.hash !== hash || !file ) {
        res.status( 404 ).json( { ok: false, error: 'No such wallpaper' } );
        return;
    }
    res.sendFile( path.join( config.paths.wallpaper, path.basename( file ) ), { maxAge: '365d', immutable: true } );
} );

/**
 * @description GET /api/box/apk/:id - an uploaded APK
 */
router.get( '/apk/:id', function( req, res ) {
    const row = db.prepare( 'SELECT file_name, package, version_code FROM apks WHERE id = ?' ).get( int( req.params.id, 2147483647 ) );
    const file = row ? apk.pathOf( row.file_name ) : '';
    if ( !row || !fs.existsSync( file ) ) {
        res.status( 404 ).json( { ok: false, error: 'No such APK' } );
        return;
    }
    res.setHeader( 'Content-Type', 'application/vnd.android.package-archive' );
    res.download( file, row.package + '_' + row.version_code + '.apk' );
} );

module.exports = router;
