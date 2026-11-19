/**
 * Web page API (/admin/api). Everything except state / sign-in / setup needs a signed-in person.
 */

'use strict';

const fs      = require( 'fs' );
const path    = require( 'path' );
const crypto  = require( 'crypto' );
const express = require( 'express' );
const multer  = require( 'multer' );
const config  = require( '../config/config' );
const logger  = require( '../modules/logger' );
const auth    = require( '../modules/auth' );
const apk     = require( '../modules/apk' );
const adb     = require( '../modules/adb' );
const { db, setting, setSetting, bumpButtonsRev, displayTarget } = require( '../modules/db' );

const router = express.Router();
const json   = express.json( { limit: '64kb' } );

fs.mkdirSync( config.paths.uploads, { recursive: true } );
fs.mkdirSync( config.paths.wallpaper, { recursive: true } );

const PKG_RE      = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const ACTIVITY_RE = /^\.?[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_$]+)*$/;
const MAC_RE      = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const MODE_RE     = /^[A-Za-z0-9 ().x]{1,40}$/;

/**
 * @description Reads a screen size / resolution sent by the page
 * @param {object} body - { scale: null | 80-100, mode: null | name }
 * @returns {object} { ok, error, scale, mode } (null = leave as it is / use the hotel setting)
 */
function readDisplay( body ) {
    const scale = body && body.scale !== null && body.scale !== undefined && body.scale !== '' ? Number( body.scale ) : null;
    const mode  = body && body.mode ? String( body.mode ).trim() : null;
    if ( scale !== null && ( !Number.isInteger( scale ) || scale < 80 || scale > 100 ) ) {
        return { ok: false, error: 'The screen size must be from 80 to 100 %' };
    }
    if ( mode !== null && !MODE_RE.test( mode ) ) {
        return { ok: false, error: 'The resolution is not valid' };
    }
    return { ok: true, scale: scale, mode: mode };
}

/**
 * @description A box's reported supported resolutions
 * @param {object} b - boxes row
 * @returns {Array<string>}
 */
function modesOf( b ) {
    try {
        const list = JSON.parse( b.display_modes || '[]' );
        return Array.isArray( list ) ? list : [];
    } catch ( e ) {
        return [];
    }
}

const wallpaperUpload = multer( { dest: config.paths.uploads, limits: { fileSize: config.limits.wallpaperBytes, files: 1 } } ).single( 'file' );
const apkUpload       = multer( { dest: config.paths.uploads, limits: { fileSize: config.limits.apkBytes, files: 1 } } ).single( 'file' );

/**
 * @description Runs a multer upload and answers 400 on its errors (e.g. file too large)
 * @param {function} upload - multer middleware
 * @returns {function} Express middleware
 */
function withUpload( upload ) {
    return function( req, res, next ) {
        upload( req, res, function( err ) {
            if ( err ) {
                res.status( 400 ).json( { ok: false, error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large' : 'Upload failed: ' + err.message } );
                return;
            }
            if ( !req.file ) {
                res.status( 400 ).json( { ok: false, error: 'Choose a file' } );
                return;
            }
            next();
        } );
    };
}

/**
 * @description Removes an uploaded temporary file, ignoring errors
 * @param {object} file - multer file
 * @returns {void}
 */
function dropUpload( file ) {
    if ( file && file.path ) {
        fs.unlink( file.path, () => {} );
    }
}

/**
 * @description Wraps an async route so a thrown error becomes a 500 answer
 * @param {function} fn - async ( req, res )
 * @returns {function}
 */
function safe( fn ) {
    return function( req, res ) {
        Promise.resolve( fn( req, res ) ).catch( function( err ) {
            logger.error( req.method + ' ' + req.originalUrl + ': ' + ( err.stack || err.message ) );
            if ( !res.headersSent ) {
                res.status( 500 ).json( { ok: false, error: 'Something went wrong on the CMS: ' + err.message } );
            }
        } );
    };
}

// ---------- Sign-in ----------

router.get( '/state', function( req, res ) {
    res.json( { ok: true, set_up: !!setting( 'property_id' ), property_name: setting( 'property_name' ), version: config.version } );
} );
router.post( '/sign-in', json, safe( auth.signIn ) );
router.post( '/setup', json, safe( auth.setup ) );
router.post( '/sign-out', auth.signOut );

router.use( auth.requireUser );

router.get( '/me', function( req, res ) {
    res.json( { ok: true, user: req.user, property_id: setting( 'property_id' ), property_name: setting( 'property_name' ), version: config.version } );
} );

// ---------- Boxes ----------

/**
 * @description GET /boxes - every box with its versions and the state of each offered APK
 */
router.get( '/boxes', function( req, res ) {
    const offered = db.prepare( `
        SELECT a.id, a.package, a.label, a.version_code, a.version_name FROM apks a
        WHERE a.active = 1 AND a.id = ( SELECT b.id FROM apks b WHERE b.package = a.package AND b.active = 1
                                        ORDER BY b.version_code DESC, b.uploaded_on DESC LIMIT 1 )` ).all();
    const buttons  = db.prepare( 'SELECT DISTINCT package FROM buttons' ).all().map( ( r ) => r.package );
    const apps     = db.prepare( 'SELECT mac, package, version_code, version_name FROM box_apps' ).all();
    const results  = db.prepare( 'SELECT mac, apk_id, state, message, via, updated_on FROM box_apk_results' ).all();
    const appsOf   = {};
    const resultOf = {};
    apps.forEach( ( a ) => { ( appsOf[ a.mac ] = appsOf[ a.mac ] || {} )[ a.package ] = a; } );
    results.forEach( ( r ) => { resultOf[ r.mac + '|' + r.apk_id ] = r; } );

    const boxes = db.prepare( 'SELECT * FROM boxes ORDER BY box_name COLLATE NOCASE, mac' ).all().map( function( b ) {
        const mine = appsOf[ b.mac ] || {};
        // Launcher version comes from the check-in itself
        mine[ 'com.excel.estvlauncher.custom' ] = { version_code: b.launcher_version_code, version_name: b.launcher_version_name };
        const updates = offered.map( function( o ) {
            const have   = mine[ o.package ];
            const result = resultOf[ b.mac + '|' + o.id ];
            let state;
            if ( have && have.version_code >= o.version_code ) {
                state = 'up_to_date';
            } else if ( result && result.state === 'failed' ) {
                state = 'failed';
            } else {
                state = 'pending';
            }
            return {
                apk_id:       o.id,
                package:      o.package,
                target:       o.version_name || String( o.version_code ),
                installed:    have ? ( have.version_name || String( have.version_code ) ) : '',
                state:        state,
                message:      result && state === 'failed' ? result.message : ''
            };
        } );
        return {
            mac:            b.mac,
            box_name:       b.box_name,
            ip:             b.ip,
            launcher:       b.launcher_version_name || ( b.launcher_version_code ? String( b.launcher_version_code ) : '' ),
            apps:           buttons.map( ( p ) => ( {
                package: p,
                version: mine[ p ] && mine[ p ].version_code > 0 ? ( mine[ p ].version_name || String( mine[ p ].version_code ) ) : ''
            } ) ),
            buttons_source: b.buttons_source,
            firmware:       b.firmware,
            android:        b.android,
            first_seen:     b.first_seen,
            last_seen:      b.last_seen,
            updates:        updates,
            display:        {
                scale:          b.display_scale,
                mode:           b.display_mode,
                modes:          modesOf( b ),
                override_scale: b.override_scale,
                override_mode:  b.override_mode,
                target:         displayTarget( b )
            }
        };
    } );
    res.json( { ok: true, now: Date.now(), online_ms: config.boxes.onlineMs, late_ms: config.boxes.lateMs, boxes: boxes } );
} );

/**
 * @description DELETE /boxes/:mac - forgets a box (it comes back at its next check-in if it still exists)
 */
router.delete( '/boxes/:mac', function( req, res ) {
    const mac = String( req.params.mac || '' ).toUpperCase();
    if ( !MAC_RE.test( mac ) ) {
        res.status( 400 ).json( { ok: false, error: 'Invalid MAC' } );
        return;
    }
    db.prepare( 'DELETE FROM boxes WHERE mac = ?' ).run( mac );
    logger.info( 'Box ' + mac + ' removed by ' + req.user.user_id );
    res.json( { ok: true } );
} );

/**
 * @description PUT /boxes/:mac/display { scale, mode } - this box's own screen size / resolution (null = hotel setting)
 */
router.put( '/boxes/:mac/display', json, function( req, res ) {
    const mac = String( req.params.mac || '' ).toUpperCase();
    const box = MAC_RE.test( mac ) ? db.prepare( 'SELECT * FROM boxes WHERE mac = ?' ).get( mac ) : null;
    if ( !box ) {
        res.status( 404 ).json( { ok: false, error: 'No such box' } );
        return;
    }
    const d = readDisplay( req.body );
    if ( !d.ok ) {
        res.status( 400 ).json( d );
        return;
    }
    if ( d.mode !== null && modesOf( box ).length > 0 && modesOf( box ).indexOf( d.mode ) < 0 ) {
        res.status( 400 ).json( { ok: false, error: 'This box\'s TV does not report ' + d.mode });
        return;
    }
    db.prepare( 'UPDATE boxes SET override_scale = ?, override_mode = ? WHERE mac = ?' ).run( d.scale, d.mode, mac );
    logger.info( 'Display of box ' + mac + ' set by ' + req.user.user_id + ': size ' + ( d.scale === null ? 'hotel' : d.scale + '%' )
               + ', resolution ' + ( d.mode === null ? 'hotel' : d.mode ) );
    res.json( { ok: true } );
} );

// ---------- Display (hotel-wide) ----------

/**
 * @description GET /display - hotel setting, and the resolutions the boxes report (with how many boxes support each)
 */
router.get( '/display', function( req, res ) {
    const boxes = db.prepare( 'SELECT display_scale, display_mode, display_modes FROM boxes' ).all();
    const count = {};
    let reporting = 0;
    boxes.forEach( function( b ) {
        const list = modesOf( b );
        if ( list.length > 0 || b.display_scale >= 0 ) {
            reporting++;
        }
        list.forEach( ( m ) => { count[ m ] = ( count[ m ] || 0 ) + 1; } );
    } );
    res.json( {
        ok:        true,
        scale:     Number( setting( 'display_scale', '0' ) ) || null,
        mode:      setting( 'display_mode' ) || null,
        modes:     Object.keys( count ).map( ( m ) => ( { mode: m, boxes: count[ m ] } ) ),
        boxes:     boxes.length,
        reporting: reporting
    } );
} );

/**
 * @description PUT /display { scale, mode } - hotel-wide screen size / resolution (null = leave the boxes as they are)
 */
router.put( '/display', json, function( req, res ) {
    const d = readDisplay( req.body );
    if ( !d.ok ) {
        res.status( 400 ).json( d );
        return;
    }
    setSetting( 'display_scale', d.scale );
    setSetting( 'display_mode', d.mode );
    logger.info( 'Hotel display set by ' + req.user.user_id + ': size ' + ( d.scale === null ? 'unchanged' : d.scale + '%' )
               + ', resolution ' + ( d.mode === null ? 'unchanged' : d.mode ) );
    res.json( { ok: true } );
} );

// ---------- Wallpaper ----------

router.get( '/wallpaper', function( req, res ) {
    const hash = setting( 'wallpaper_hash' );
    res.json( { ok: true, wallpaper: hash ? {
        hash:        hash,
        url:         '/api/box/wallpaper/' + hash,
        original:    setting( 'wallpaper_original' ),
        size:        Number( setting( 'wallpaper_size', '0' ) ),
        uploaded_on: Number( setting( 'wallpaper_uploaded_on', '0' ) ),
        uploaded_by: setting( 'wallpaper_uploaded_by' )
    } : null } );
} );

router.post( '/wallpaper', withUpload( wallpaperUpload ), safe( async function( req, res ) {
    const file = req.file;
    const head = Buffer.alloc( 8 );
    const fd   = fs.openSync( file.path, 'r' );
    fs.readSync( fd, head, 0, 8, 0 );
    fs.closeSync( fd );
    const ext = head[ 0 ] === 0xFF && head[ 1 ] === 0xD8 && head[ 2 ] === 0xFF ? 'jpg'
              : head.toString( 'hex', 0, 8 ) === '89504e470d0a1a0a' ? 'png' : '';
    if ( !ext ) {
        dropUpload( file );
        res.status( 400 ).json( { ok: false, error: 'Only JPG and PNG pictures can be used' } );
        return;
    }
    const hash = await apk.sha256File( file.path );
    const name = hash + '.' + ext;
    const old  = setting( 'wallpaper_file' );
    fs.renameSync( file.path, path.join( config.paths.wallpaper, name ) );
    if ( old && old !== name ) {
        fs.unlink( path.join( config.paths.wallpaper, path.basename( old ) ), () => {} );
    }
    setSetting( 'wallpaper_hash', hash );
    setSetting( 'wallpaper_file', name );
    setSetting( 'wallpaper_original', String( file.originalname || '' ).slice( 0, 150 ) );
    setSetting( 'wallpaper_size', file.size );
    setSetting( 'wallpaper_uploaded_on', Date.now() );
    setSetting( 'wallpaper_uploaded_by', req.user.user_id );
    logger.info( 'Wallpaper changed by ' + req.user.user_id + ' (' + file.originalname + ')' );
    res.json( { ok: true } );
} ) );

router.delete( '/wallpaper', function( req, res ) {
    const old = setting( 'wallpaper_file' );
    if ( old ) {
        fs.unlink( path.join( config.paths.wallpaper, path.basename( old ) ), () => {} );
    }
    [ 'wallpaper_hash', 'wallpaper_file', 'wallpaper_original', 'wallpaper_size', 'wallpaper_uploaded_on', 'wallpaper_uploaded_by' ]
        .forEach( ( k ) => setSetting( k, null ) );
    logger.info( 'Wallpaper reset to the default by ' + req.user.user_id );
    res.json( { ok: true } );
} );

// ---------- Home buttons ----------

router.get( '/buttons', function( req, res ) {
    res.json( { ok: true, rev: Number( setting( 'buttons_rev', '0' ) ),
                buttons: db.prepare( 'SELECT name, package, activity FROM buttons ORDER BY sort, id' ).all() } );
} );

/**
 * @description PUT /buttons { buttons: [ { name, package, activity } ] } - replaces the whole list, in order
 */
router.put( '/buttons', json, function( req, res ) {
    const list = req.body && Array.isArray( req.body.buttons ) ? req.body.buttons : null;
    if ( !list || list.length > 12 ) {
        res.status( 400 ).json( { ok: false, error: list ? 'At most 12 buttons' : 'No buttons sent' } );
        return;
    }
    const clean = [];
    for ( let i = 0; i < list.length; i++ ) {
        const b        = list[ i ] || {};
        const name     = String( b.name || '' ).trim();
        const pkg      = String( b.package || '' ).trim();
        const activity = String( b.activity || '' ).trim();
        const n        = 'Button ' + ( i + 1 );
        if ( !name || name.length > 30 ) {
            res.status( 400 ).json( { ok: false, error: n + ': the name must be 1 to 30 characters' } );
            return;
        }
        if ( name.toLowerCase() === 'menu' ) {
            res.status( 400 ).json( { ok: false, error: n + ': "Menu" is always shown first; choose another name' } );
            return;
        }
        if ( !PKG_RE.test( pkg ) || pkg.length > 150 ) {
            res.status( 400 ).json( { ok: false, error: n + ': the package name is not valid (e.g. com.example.app)' } );
            return;
        }
        if ( activity && ( !ACTIVITY_RE.test( activity ) || activity.length > 200 ) ) {
            res.status( 400 ).json( { ok: false, error: n + ': the activity is not valid (e.g. .MainActivity or com.example.app.MainActivity)' } );
            return;
        }
        clean.push( { name: name, package: pkg, activity: activity } );
    }
    let rev;
    db.transaction( function() {
        db.prepare( 'DELETE FROM buttons' ).run();
        const ins = db.prepare( 'INSERT INTO buttons ( name, package, activity, sort ) VALUES ( ?, ?, ?, ? )' );
        clean.forEach( ( b, i ) => ins.run( b.name, b.package, b.activity, i ) );
        rev = bumpButtonsRev();
    } )();
    logger.info( 'Home buttons changed by ' + req.user.user_id + ' (rev ' + rev + ', ' + clean.length + ' buttons)' );
    res.json( { ok: true, rev: rev } );
} );

// ---------- APKs ----------

/**
 * @description GET /apks - uploaded APKs, with how many boxes have each offered one
 */
router.get( '/apks', function( req, res ) {
    const rows  = db.prepare( 'SELECT * FROM apks ORDER BY package, version_code DESC, uploaded_on DESC' ).all();
    const boxes = db.prepare( 'SELECT mac, box_name, ip, launcher_version_code, launcher_version_name, last_seen FROM boxes' ).all();
    const apps  = db.prepare( 'SELECT mac, package, version_code, version_name FROM box_apps' ).all();
    const res2  = db.prepare( 'SELECT mac, apk_id, state, message, via, updated_on FROM box_apk_results' ).all();
    const have  = {};
    apps.forEach( ( a ) => { have[ a.mac + '|' + a.package ] = a; } );
    boxes.forEach( ( b ) => { have[ b.mac + '|com.excel.estvlauncher.custom' ] = { version_code: b.launcher_version_code, version_name: b.launcher_version_name }; } );
    const resultOf = {};
    res2.forEach( ( r ) => { resultOf[ r.mac + '|' + r.apk_id ] = r; } );

    // The offered APK of each package: newest active
    const offeredId = {};
    rows.forEach( ( r ) => {
        if ( r.active && !( r.package in offeredId ) ) {
            offeredId[ r.package ] = r.id;
        }
    } );

    const apks = rows.map( function( r ) {
        const perBox = boxes.map( function( b ) {
            const h      = have[ b.mac + '|' + r.package ];
            const result = resultOf[ b.mac + '|' + r.id ];
            const state  = h && h.version_code >= r.version_code ? 'up_to_date'
                         : result && result.state === 'failed' ? 'failed' : 'pending';
            return {
                mac:       b.mac,
                box_name:  b.box_name,
                ip:        b.ip,
                last_seen: b.last_seen,
                installed: h && h.version_code > 0 ? ( h.version_name || String( h.version_code ) ) : '',
                state:     state,
                message:   result && state === 'failed' ? result.message : '',
                via:       result ? result.via : ''
            };
        } );
        return {
            id:           r.id,
            package:      r.package,
            label:        r.label,
            version_code: r.version_code,
            version_name: r.version_name,
            size:         r.size,
            sha256:       r.sha256,
            original:     r.original,
            active:       !!r.active,
            offered:      offeredId[ r.package ] === r.id,
            uploaded_on:  r.uploaded_on,
            uploaded_by:  r.uploaded_by,
            done:         perBox.filter( ( x ) => x.state === 'up_to_date' ).length,
            failed:       perBox.filter( ( x ) => x.state === 'failed' ).length,
            boxes:        perBox
        };
    } );
    res.json( { ok: true, apks: apks } );
} );

router.post( '/apks', withUpload( apkUpload ), safe( async function( req, res ) {
    const file = req.file;
    let info;
    try {
        info = await apk.readManifest( file.path );
    } catch ( err ) {
        dropUpload( file );
        res.status( 400 ).json( { ok: false, error: err.message } );
        return;
    }
    const sha256 = await apk.sha256File( file.path );
    const dup    = db.prepare( 'SELECT id FROM apks WHERE sha256 = ?' ).get( sha256 );
    if ( dup ) {
        dropUpload( file );
        res.status( 409 ).json( { ok: false, error: 'This APK has been uploaded already' } );
        return;
    }
    const name = apk.store( file.path, info, sha256 );
    const r    = db.prepare( `INSERT INTO apks ( package, label, version_code, version_name, sha256, size, file_name, original, active, uploaded_on, uploaded_by )
                              VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ? )` )
                   .run( info.package, info.label, info.version_code, info.version_name, sha256, file.size, name,
                         String( file.originalname || '' ).slice( 0, 150 ), Date.now(), req.user.user_id );
    logger.info( 'APK uploaded by ' + req.user.user_id + ': ' + info.package + ' ' + info.version_name + ' (' + info.version_code + ')' );
    res.json( { ok: true, apk: Object.assign( { id: Number( r.lastInsertRowid ) }, info ) } );
} ) );

/**
 * @description PATCH /apks/:id { active } - offers an APK to the boxes or stops offering it
 */
router.patch( '/apks/:id', json, function( req, res ) {
    const id = Number( req.params.id );
    const r  = db.prepare( 'UPDATE apks SET active = ? WHERE id = ?' ).run( req.body && req.body.active ? 1 : 0, id );
    if ( r.changes === 0 ) {
        res.status( 404 ).json( { ok: false, error: 'No such APK' } );
        return;
    }
    logger.info( 'APK ' + id + ( req.body.active ? ' offered' : ' withdrawn' ) + ' by ' + req.user.user_id );
    res.json( { ok: true } );
} );

router.delete( '/apks/:id', function( req, res ) {
    const row = db.prepare( 'SELECT file_name FROM apks WHERE id = ?' ).get( Number( req.params.id ) );
    if ( !row ) {
        res.status( 404 ).json( { ok: false, error: 'No such APK' } );
        return;
    }
    db.prepare( 'DELETE FROM apks WHERE id = ?' ).run( Number( req.params.id ) );
    fs.unlink( apk.pathOf( row.file_name ), () => {} );
    logger.info( 'APK ' + req.params.id + ' deleted by ' + req.user.user_id );
    res.json( { ok: true } );
} );

/**
 * @description POST /apks/:id/adb { mac } - backup install on one box over network ADB from this PC
 */
router.post( '/apks/:id/adb', json, safe( async function( req, res ) {
    const row = db.prepare( 'SELECT id, file_name, package, version_name FROM apks WHERE id = ?' ).get( Number( req.params.id ) );
    const mac = String( ( req.body && req.body.mac ) || '' ).toUpperCase();
    const box = MAC_RE.test( mac ) ? db.prepare( 'SELECT mac, ip FROM boxes WHERE mac = ?' ).get( mac ) : null;
    if ( !row || !box ) {
        res.status( 404 ).json( { ok: false, error: row ? 'No such box' : 'No such APK' } );
        return;
    }
    logger.info( 'ADB install of ' + row.package + ' ' + row.version_name + ' on ' + box.mac + ' (' + box.ip + ') by ' + req.user.user_id );
    const result = await adb.install( box.ip, apk.pathOf( row.file_name ) );
    db.prepare( `INSERT INTO box_apk_results ( mac, apk_id, state, message, via, updated_on ) VALUES ( ?, ?, ?, ?, 'adb', ? )
                 ON CONFLICT( mac, apk_id ) DO UPDATE SET state = excluded.state, message = excluded.message, via = 'adb', updated_on = excluded.updated_on` )
      .run( box.mac, row.id, result.ok ? 'installed' : 'failed', result.message, Date.now() );
    logger.info( 'ADB install on ' + box.mac + ': ' + ( result.ok ? 'done' : 'failed - ' + result.message ) );
    res.json( { ok: result.ok, error: result.ok ? undefined : result.message,
                message: result.ok ? 'Installed. The box shows the new version at its next check-in.' : undefined } );
} ) );

// ---------- Settings ----------

router.get( '/settings', safe( async function( req, res ) {
    res.json( {
        ok:            true,
        property_id:   setting( 'property_id' ),
        property_name: setting( 'property_name' ),
        lan_ip:        auth.lanIp(),
        port:          config.port,
        version:       config.version,
        adb_path:      setting( 'adb_path' ),
        adb_version:   await adb.version()
    } );
} ) );

/**
 * @description POST /settings { adb_path } - where adb.exe is (empty = from PATH)
 */
router.post( '/settings', json, function( req, res ) {
    const p = String( ( req.body && req.body.adb_path ) || '' ).trim();
    if ( p && ( !/[\\/]adb(\.exe)?$/i.test( p ) || !fs.existsSync( p ) ) ) {
        res.status( 400 ).json( { ok: false, error: 'Give the full path of adb.exe, e.g. C:\\platform-tools\\adb.exe' } );
        return;
    }
    setSetting( 'adb_path', p || null );
    res.json( { ok: true } );
} );

/**
 * @description POST /settings/change-property - forgets the property; the next sign-in chooses it again
 */
router.post( '/settings/change-property', function( req, res ) {
    logger.info( 'Property link removed by ' + req.user.user_id + ' (was ' + setting( 'property_name' ) + ')' );
    auth.resetSetup();
    res.setHeader( 'Set-Cookie', config.session.cookie + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' );
    res.json( { ok: true } );
} );

module.exports = router;
