'use strict';

/**
 * test/run.js - end-to-end checks of the box API and the web page API, on a temporary data folder and a free
 * port. No eslink: a test session is written straight into the temporary database.
 *
 *   node test/run.js
 */

const fs     = require( 'fs' );
const os     = require( 'os' );
const path   = require( 'path' );
const zlib   = require( 'zlib' );
const { spawn } = require( 'child_process' );

const DATA = fs.mkdtempSync( path.join( os.tmpdir(), 'cms-test-' ) );
const PORT = 4900 + Math.floor( Math.random() * 90 );
const BASE = 'http://127.0.0.1:' + PORT;
const COOKIE = 'cms_session=test-session';
const FAKE_PORT = PORT + 1000;            // Stand-in for eslink.online's webservice.php

let failed = 0;
let count  = 0;

/**
 * @description One check
 * @param {string} name - What is checked
 * @param {boolean} ok - Result
 * @param {*} [got] - Shown on failure
 * @returns {void}
 */
function check( name, ok, got ) {
    count++;
    if ( !ok ) {
        failed++;
    }
    console.log( ( ok ? 'PASS ' : 'FAIL ' ) + name + ( ok ? '' : '  [' + JSON.stringify( got ) + ']' ) );
}

/**
 * @description HTTP call to the test server
 * @param {string} method - Method
 * @param {string} url - Path
 * @param {*} [body] - JSON body or FormData
 * @param {boolean} [signedIn=true] - Send the test session
 * @returns {Promise<{status:number, json:*, buf:Buffer, type:string}>}
 */
async function call( method, url, body, signedIn ) {
    const headers = signedIn === false ? {} : { Cookie: COOKIE };
    let payload;
    if ( body instanceof FormData ) {
        payload = body;
    } else if ( body !== undefined ) {
        headers[ 'Content-Type' ] = 'application/json';
        payload = typeof body === 'string' ? body : JSON.stringify( body );
    }
    const r    = await fetch( BASE + url, { method: method, headers: headers, body: payload } );
    const buf  = Buffer.from( await r.arrayBuffer() );
    const type = r.headers.get( 'content-type' ) || '';
    let json   = null;
    try { json = JSON.parse( buf.toString() ); } catch ( e ) { /* binary */ }
    return { status: r.status, json: json, buf: buf, type: type };
}

/**
 * @description A tiny valid PNG
 * @returns {Buffer}
 */
function png() {
    const crcTable = [];
    for ( let n = 0; n < 256; n++ ) {
        let c = n;
        for ( let k = 0; k < 8; k++ ) { c = c & 1 ? 0xEDB88320 ^ ( c >>> 1 ) : c >>> 1; }
        crcTable[ n ] = c >>> 0;
    }
    const crc = ( b ) => { let c = 0xFFFFFFFF; for ( const x of b ) { c = crcTable[ ( c ^ x ) & 0xFF ] ^ ( c >>> 8 ); } return ( c ^ 0xFFFFFFFF ) >>> 0; };
    const chunk = ( type, data ) => {
        const len = Buffer.alloc( 4 ); len.writeUInt32BE( data.length );
        const td  = Buffer.concat( [ Buffer.from( type ), data ] );
        const c   = Buffer.alloc( 4 ); c.writeUInt32BE( crc( td ) );
        return Buffer.concat( [ len, td, c ] );
    };
    const ihdr = Buffer.alloc( 13 ); ihdr.writeUInt32BE( 4, 0 ); ihdr.writeUInt32BE( 4, 4 ); ihdr[ 8 ] = 8; ihdr[ 9 ] = 2;
    const raw  = Buffer.alloc( 4 * 13, 0x40 ); for ( let r = 0; r < 4; r++ ) { raw[ r * 13 ] = 0; }
    return Buffer.concat( [ Buffer.from( '89504e470d0a1a0a', 'hex' ), chunk( 'IHDR', ihdr ), chunk( 'IDAT', zlib.deflateSync( raw ) ), chunk( 'IEND', Buffer.alloc( 0 ) ) ] );
}

/**
 * @description Waits until the server answers
 * @returns {Promise<void>}
 */
async function waitUp() {
    for ( let i = 0; i < 50; i++ ) {
        try { await fetch( BASE + '/admin/api/state' ); return; } catch ( e ) { await new Promise( ( r ) => setTimeout( r, 200 ) ); }
    }
    throw new Error( 'The server did not start' );
}

/**
 * @description Stand-in for eslink's webservice.php: password "right" signs in; answers the two Custom Launcher calls
 * @returns {http.Server}
 */
function fakeEslink() {
    return require( 'http' ).createServer( function( req, res ) {
        let b = '';
        req.on( 'data', ( d ) => { b += d; } ).on( 'end', function() {
            const p = Object.fromEntries( new URLSearchParams( b ) );
            let out;
            if ( p.what_do_you_want === 'scodezy_login' ) {
                out = p.password === 'right' ? { type: 'success', info: { xAwBo5Re9a: 'tok' } } : { type: 'error', info: 'Invalid username/password' };
            } else if ( p.what_do_you_want === 'eslink_custom_launcher_cms_properties' ) {
                out = { type: 'success', info: [ { property_id: '1112268135', property_name: 'VM Hotel', cms_host: '', cms_port: 4053 } ] };
            } else if ( p.what_do_you_want === 'eslink_custom_launcher_cms_sign_in' ) {
                out = { type: 'success', info: { user: { user_id: p.xAwBo5Re9a ? 'admin' : '', name: 'Admin', role_name: 'Administrator' },
                                                 property_id: p.property_id, property_name: p.property_id === '1112268135' ? 'VM Hotel' : 'Test Hotel' } };
            } else {
                out = { type: 'error', info: 'unknown' };
            }
            res.setHeader( 'Content-Type', 'application/json' );
            res.end( JSON.stringify( [ out ] ) );
        } );
    } ).listen( FAKE_PORT );
}

( async function main() {
    const fake = fakeEslink();
    // Database with a test session and a property, before the server opens it
    process.env.CMS_DATA_DIR = DATA;
    const { db, setSetting } = require( '../modules/db' );
    db.prepare( 'INSERT INTO sessions VALUES ( ?, ?, ?, ?, ?, ? )' ).run( 'test-session', 'tester', 'Tester', 'Administrator', Date.now(), Date.now() );
    setSetting( 'property_id', '1234567890' );
    setSetting( 'property_name', 'Test Hotel' );
    db.close();

    const server = spawn( process.execPath, [ 'server.js' ], {
        cwd: path.join( __dirname, '..' ),
        env: Object.assign( {}, process.env, { CMS_PORT: String( PORT ), CMS_DATA_DIR: DATA, ESLINK_API_URL: 'http://127.0.0.1:' + FAKE_PORT + '/' } ),
        stdio: 'ignore'
    } );

    try {
        await waitUp();
        const MAC = 'AA:BB:CC:00:00:01';

        // ---------- Box API ----------
        let r = await call( 'POST', '/api/box/checkin', { mac: 'nope' }, false );
        check( 'check-in refuses a bad MAC', r.status === 400, r.json );
        r = await call( 'POST', '/api/box/checkin', '{bad json', false );
        check( 'malformed JSON gets a short JSON error', r.status === 400 && r.json && r.json.ok === false && !/at /.test( r.buf.toString() ), r.buf.toString() );
        r = await call( 'POST', '/api/box/checkin', { mac: 'aa-bb-cc-00-00-01', ip: '172.19.0.50', box_name: 'Lobby', launcher: { version_code: 1, version_name: '1.0.0' },
                                                     apps: [ { package: 'com.example.player', version_code: 0, version_name: '' } ], buttons_source: 'cms', buttons_rev: 0 }, false );
        check( 'check-in answers property, interval, no wallpaper, empty buttons', r.json && r.json.ok && r.json.property_id === '1234567890'
               && r.json.interval_sec === 300 && r.json.wallpaper === null && r.json.buttons.rev === 0 && r.json.apks.length === 0, r.json );

        r = await call( 'POST', '/api/box/checkin', { mac: MAC, apk_results: [] }, false );
        r = await call( 'GET', '/admin/api/boxes' );
        const box = r.json && r.json.boxes.find( ( b ) => b.mac === MAC );
        check( 'a partial check-in keeps name, IP and launcher version', box && box.box_name === 'Lobby' && box.ip === '172.19.0.50' && box.launcher === '1.0.0', box );

        // ---------- Sign-in protection ----------
        r = await call( 'GET', '/admin/api/boxes', undefined, false );
        check( 'web API needs a session', r.status === 401, r.status );
        r = await call( 'POST', '/admin/api/sign-in', { user_id: 'admin', password: 'wrong' }, false );
        check( 'a wrong password shows eslink\'s message', r.status === 401 && r.json.error === 'Invalid username/password', r.json );
        r = await call( 'POST', '/admin/api/sign-in', { user_id: 'admin', password: 'right' }, false );
        check( 'sign-in for the property answers the eslink user', r.json && r.json.ok && r.json.user.user_id === 'admin', r.json );

        // ---------- Wallpaper ----------
        let fd = new FormData();
        fd.append( 'file', new Blob( [ Buffer.from( 'not a picture' ) ] ), 'x.txt' );
        r = await call( 'POST', '/admin/api/wallpaper', fd );
        check( 'wallpaper refuses a non-picture', r.status === 400, r.json );
        fd = new FormData();
        fd.append( 'file', new Blob( [ png() ] ), 'wall.png' );
        r = await call( 'POST', '/admin/api/wallpaper', fd );
        check( 'wallpaper upload', r.json && r.json.ok, r.json );
        r = await call( 'POST', '/api/box/checkin', { mac: MAC }, false );
        const wall = r.json.wallpaper;
        check( 'check-in carries the wallpaper hash', wall && /^[0-9a-f]{64}$/.test( wall.hash ), wall );
        r = await call( 'GET', wall.url, undefined, false );
        check( 'wallpaper download', r.status === 200 && r.type.indexOf( 'image/png' ) === 0, r.type );
        r = await call( 'GET', '/api/box/wallpaper/' + '0'.repeat( 64 ), undefined, false );
        check( 'old wallpaper hash is 404', r.status === 404, r.status );

        // ---------- Home buttons ----------
        r = await call( 'PUT', '/admin/api/buttons', { buttons: [ { name: 'Menu', package: 'com.a.b' } ] } );
        check( 'a button named Menu is refused', r.status === 400, r.json );
        r = await call( 'PUT', '/admin/api/buttons', { buttons: [ { name: 'TV', package: 'bad' } ] } );
        check( 'a bad package is refused', r.status === 400, r.json );
        r = await call( 'PUT', '/admin/api/buttons', { buttons: [ { name: 'TV', package: 'com.a.b', activity: 'com.a b.Main' } ] } );
        check( 'a bad activity is refused', r.status === 400, r.json );
        r = await call( 'PUT', '/admin/api/buttons', { buttons: [ { name: 'Movies', package: 'com.example.player', activity: '.Main' }, { name: 'TV', package: 'com.example.tv' } ] } );
        check( 'buttons saved, revision 1', r.json && r.json.rev === 1, r.json );
        r = await call( 'POST', '/api/box/checkin', { mac: MAC }, false );
        check( 'check-in carries the buttons in order', r.json.buttons.rev === 1 && r.json.buttons.list.map( ( b ) => b.name ).join() === 'Movies,TV'
               && r.json.buttons.list[ 0 ].activity === '.Main' && r.json.buttons.list[ 1 ].activity === '', r.json.buttons );

        // ---------- APKs ----------
        fd = new FormData();
        fd.append( 'file', new Blob( [ png() ] ), 'fake.apk' );
        r = await call( 'POST', '/admin/api/apks', fd );
        check( 'a file that is not an APK is refused', r.status === 400, r.json );
        const sample = process.env.CMS_TEST_APK;
        if ( sample && fs.existsSync( sample ) ) {
            fd = new FormData();
            fd.append( 'file', new Blob( [ fs.readFileSync( sample ) ] ), path.basename( sample ) );
            r = await call( 'POST', '/admin/api/apks', fd );
            check( 'APK upload reads package and version', r.json && r.json.ok && r.json.apk.version_code > 0, r.json );
            const pkg = r.json.apk.package;
            r = await call( 'POST', '/api/box/checkin', { mac: MAC, apps: [ { package: pkg, version_code: 1, version_name: 'old' } ] }, false );
            const offer = r.json.apks.find( ( a ) => a.package === pkg );
            check( 'check-in offers the APK with sha256 and size', offer && /^[0-9a-f]{64}$/.test( offer.sha256 ) && offer.size > 0, r.json.apks );
            r = await call( 'GET', offer.url, undefined, false );
            check( 'APK download is complete', r.status === 200 && r.buf.length === offer.size, r.buf.length );
            await call( 'POST', '/api/box/checkin', { mac: MAC, apk_results: [ { apk_id: offer.apk_id, state: 'failed', message: 'INSTALL_FAILED_TEST' } ] }, false );
            r = await call( 'GET', '/admin/api/apks' );
            const row = r.json.apks[ 0 ].boxes.find( ( b ) => b.mac === MAC );
            check( 'a failed install shows on the APK page', row && row.state === 'failed' && row.message === 'INSTALL_FAILED_TEST', row );
            // The launcher reports its own version in "launcher", any other app in "apps"
            const now = { version_code: offer.version_code, version_name: offer.version_name };
            await call( 'POST', '/api/box/checkin', pkg === 'com.excel.estvlauncher.custom'
                        ? { mac: MAC, launcher: now } : { mac: MAC, apps: [ Object.assign( { package: pkg }, now ) ] }, false );
            r = await call( 'GET', '/admin/api/apks' );
            check( 'the box reporting the new version counts as updated', r.json.apks[ 0 ].done === 2 - 1 && r.json.apks[ 0 ].boxes.find( ( b ) => b.mac === MAC ).state === 'up_to_date', r.json.apks[ 0 ] );
            r = await call( 'PATCH', '/admin/api/apks/' + offer.apk_id, { active: false } );
            r = await call( 'POST', '/api/box/checkin', { mac: MAC }, false );
            check( 'an inactive APK is no longer offered', !r.json.apks.some( ( a ) => a.package === pkg ), r.json.apks );
        } else {
            console.log( 'SKIP APK upload checks (set CMS_TEST_APK to an .apk file)' );
        }

        // ---------- Boxes ----------
        r = await call( 'DELETE', '/admin/api/boxes/' + encodeURIComponent( MAC ) );
        r = await call( 'GET', '/admin/api/boxes' );
        check( 'a removed box is gone', !r.json.boxes.some( ( b ) => b.mac === MAC ), r.json.boxes );
        // ---------- First set-up (stateless: the page sends the user ID / password again with the property) ----------
        r = await call( 'POST', '/admin/api/settings/change-property' );
        check( 'change property forgets the property', r.json && r.json.ok, r.json );
        r = await call( 'POST', '/admin/api/sign-in', { user_id: 'admin', password: 'right' }, false );
        check( 'sign-in on a new CMS lists the properties', r.json && r.json.needs_setup && r.json.properties.length === 1, r.json );
        r = await call( 'POST', '/admin/api/setup', { user_id: 'admin', password: 'wrong', property_id: '1112268135' }, false );
        check( 'set-up with a wrong password is refused', r.status === 401, r.json );
        r = await call( 'POST', '/admin/api/setup', { user_id: 'admin', password: 'right', property_id: 'abc' }, false );
        check( 'set-up with a bad property ID is refused', r.status === 400, r.json );
        r = await call( 'POST', '/admin/api/setup', { user_id: 'admin', password: 'right', property_id: '1112268135' }, false );
        check( 'set-up links the CMS to the property', r.json && r.json.ok && r.json.property_name === 'VM Hotel', r.json );
        r = await call( 'GET', '/admin/api/state', undefined, false );
        check( 'the CMS is now set up for that property', r.json.set_up === true && r.json.property_name === 'VM Hotel', r.json );
        r = await call( 'POST', '/admin/api/setup', { user_id: 'admin', password: 'right', property_id: '1112268135' }, false );
        check( 'a second set-up is refused', r.status === 409, r.json );

        // ---------- Lock-out ----------
        for ( let i = 0; i < 9; i++ ) {
            await call( 'POST', '/admin/api/sign-in', { user_id: 'admin', password: 'wrong' }, false );
        }
        r = await call( 'POST', '/admin/api/sign-in', { user_id: 'admin', password: 'right' }, false );
        check( '10 failed sign-ins lock the address, with the minutes to wait', r.status === 429 && /in \d+ minute/.test( r.json.error ), r.json );

    } catch ( err ) {
        failed++;
        console.log( 'FAIL ' + err.stack );
    } finally {
        server.kill();
        fake.close();
        await new Promise( ( r ) => setTimeout( r, 300 ) );
        fs.rmSync( DATA, { recursive: true, force: true } );
    }

    console.log( count + ' checks, ' + failed + ' failed' );
    process.exit( failed ? 1 : 0 );
} )();
