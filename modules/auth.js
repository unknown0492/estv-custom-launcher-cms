/**
 * Web page sign-in: eslink account check, sessions in SQLite (HttpOnly cookie), a small lock-out against
 * password guessing.
 *
 * First sign-in on a new CMS: the person signs in with eslink and chooses the property; that choice is kept
 * (settings.property_id) and from then on only people with access to that property can sign in.
 */

'use strict';

const os     = require( 'os' );
const crypto = require( 'crypto' );
const config = require( '../config/config' );
const logger = require( './logger' );
const eslink = require( './eslink' );
const { db, setting, setSetting } = require( './db' );

/* Failed sign-ins per remote address: 10 within 5 minutes lock that address until the oldest is 5 minutes old */
const FAIL_LIMIT  = 10;
const FAIL_WINDOW = 5 * 60 * 1000;
const failures    = new Map();          // ip -> [ timestamps ]

const insertSession = db.prepare( 'INSERT INTO sessions ( id, user_id, name, role_name, created_on, last_seen ) VALUES ( ?, ?, ?, ?, ?, ? )' );
const findSession   = db.prepare( 'SELECT * FROM sessions WHERE id = ?' );
const touchSession  = db.prepare( 'UPDATE sessions SET last_seen = ? WHERE id = ?' );
const deleteSession = db.prepare( 'DELETE FROM sessions WHERE id = ?' );
const pruneSessions = db.prepare( 'DELETE FROM sessions WHERE last_seen < ?' );

/* Adapters that are never the hotel LAN (virtual machines, WSL, Docker, VPN) */
const VIRTUAL_ADAPTER = /virtualbox|vmware|vethernet|hyper-v|wsl|docker|loopback|vpn|tap|tailscale|zerotier/i;

/**
 * @description This PC's LAN IPv4 address: a private address of a real adapter (172.19.x first, the hotels'
 *              usual box network), else any non-internal address
 * @returns {string}
 */
function lanIp() {
    const real = [];
    const other = [];
    Object.keys( os.networkInterfaces() ).forEach( function( name ) {
        ( os.networkInterfaces()[ name ] || [] ).forEach( function( a ) {
            if ( a.family === 'IPv4' && !a.internal ) {
                ( VIRTUAL_ADAPTER.test( name ) ? other : real ).push( a.address );
            }
        } );
    } );
    const isPrivate = ( ip ) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test( ip );
    return real.find( ( ip ) => ip.startsWith( '172.19.' ) ) || real.find( isPrivate ) || real[ 0 ] || other[ 0 ] || '';
}

/**
 * @description Minutes an address still has to wait after too many failed sign-ins
 * @param {string} ip - Remote address
 * @returns {number} 0 when it may sign in
 */
function lockedMinutes( ip ) {
    const now  = Date.now();
    const list = ( failures.get( ip ) || [] ).filter( ( t ) => now - t < FAIL_WINDOW );
    failures.set( ip, list );
    return list.length >= FAIL_LIMIT ? Math.max( 1, Math.ceil( ( list[ 0 ] + FAIL_WINDOW - now ) / 60000 ) ) : 0;
}

/**
 * @description Records a failed sign-in
 * @param {string} ip - Remote address
 * @returns {void}
 */
function addFailure( ip ) {
    const list = failures.get( ip ) || [];
    list.push( Date.now() );
    failures.set( ip, list );
}

/**
 * @description Checks the lock-out and the typed user ID / password, then signs the person in to eslink.
 *              Answers the request itself when something is wrong.
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @returns {Promise<object|null>} { token, userId, ip }, or null when the request was already answered
 */
async function eslinkSignIn( req, res ) {
    const ip       = req.socket.remoteAddress || '';
    const userId   = String( ( req.body && req.body.user_id ) || '' ).trim();
    const password = String( ( req.body && req.body.password ) || '' );

    const wait = lockedMinutes( ip );
    if ( wait > 0 ) {
        res.status( 429 ).json( { ok: false, error: 'Too many failed sign-ins. Please try again in ' + wait + ( wait > 1 ? ' minutes.' : ' minute.' ) } );
        return null;
    }
    if ( !userId || !password ) {
        res.status( 400 ).json( { ok: false, error: 'Enter your eslink user ID and password' } );
        return null;
    }
    try {
        return { token: await eslink.userSignIn( userId, password ), userId: userId, ip: ip };
    } catch ( err ) {
        if ( !err.unreachable ) {
            addFailure( ip );
        }
        logger.warn( 'Sign-in refused for "' + userId.slice( 0, 50 ) + '" from ' + ip + ': ' + err.message );
        res.status( err.unreachable ? 503 : 401 ).json( { ok: false, error: err.message } );
        return null;
    }
}

/**
 * @description Reads the session cookie of a request
 * @param {object} req - Express request
 * @returns {string} Session ID or ''
 */
function cookieOf( req ) {
    const header = req.headers.cookie || '';
    const match  = header.split( ';' ).map( ( s ) => s.trim() ).find( ( s ) => s.startsWith( config.session.cookie + '=' ) );
    return match ? decodeURIComponent( match.slice( config.session.cookie.length + 1 ) ) : '';
}

/**
 * @description Creates a session and sets its cookie
 * @param {object} res - Express response
 * @param {object} user - { user_id, name, role_name }
 * @returns {void}
 */
function startSession( res, user ) {
    const id  = crypto.randomBytes( 32 ).toString( 'hex' );
    const now = Date.now();
    insertSession.run( id, user.user_id, user.name || user.user_id, user.role_name || '', now, now );
    res.setHeader( 'Set-Cookie', config.session.cookie + '=' + id + '; HttpOnly; SameSite=Strict; Path=/' );
}

/**
 * @description Express middleware: the request needs a signed-in person (req.user); else 401
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {function} next - Next handler
 * @returns {void}
 */
function requireUser( req, res, next ) {
    const id  = cookieOf( req );
    const now = Date.now();
    const row = id ? findSession.get( id ) : null;
    if ( !row || now - row.last_seen > config.session.idleMs ) {
        if ( row ) {
            deleteSession.run( id );
        }
        res.status( 401 ).json( { ok: false, error: 'Please sign in', signed_out: true } );
        return;
    }
    touchSession.run( now, id );
    req.user = { user_id: row.user_id, name: row.name, role_name: row.role_name };
    next();
}

/**
 * @description POST /admin/api/sign-in { user_id, password }. Already set up: signs in for the property.
 *              Not set up yet: answers { needs_setup, properties } for the property choice; the page then sends
 *              the same user ID / password again with the property to /setup. Nothing is kept on the CMS in
 *              between, so a restart of the CMS cannot break the set-up.
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @returns {Promise<void>}
 */
async function signIn( req, res ) {
    const auth = await eslinkSignIn( req, res );
    if ( !auth ) {
        return;
    }
    const propertyId = setting( 'property_id' );
    try {
        if ( !propertyId ) {
            res.json( { ok: true, needs_setup: true, properties: await eslink.listProperties( auth.token ) } );
            return;
        }
        const info = await eslink.cmsSignIn( auth.token, propertyId, lanIp() );
        setSetting( 'property_name', info.property_name );
        startSession( res, info.user );
        logger.info( 'Signed in: ' + info.user.user_id + ' from ' + auth.ip );
        res.json( { ok: true, user: info.user } );
    } catch ( err ) {
        logger.warn( 'Sign-in of ' + auth.userId + ' refused by eslink: ' + err.message );
        res.status( err.unreachable ? 503 : 403 ).json( { ok: false, error: err.message } );
    }
}

/**
 * @description POST /admin/api/setup { user_id, password, property_id }: first set-up, links this CMS to a property
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @returns {Promise<void>}
 */
async function setup( req, res ) {
    const propertyId = String( ( req.body && req.body.property_id ) || '' );
    if ( setting( 'property_id' ) ) {
        res.status( 409 ).json( { ok: false, error: 'This CMS is already set up. Sign in again.' } );
        return;
    }
    if ( !/^\d{1,20}$/.test( propertyId ) ) {
        res.status( 400 ).json( { ok: false, error: 'Choose a property' } );
        return;
    }
    const auth = await eslinkSignIn( req, res );
    if ( !auth ) {
        return;
    }
    try {
        const info = await eslink.cmsSignIn( auth.token, propertyId, lanIp() );
        setSetting( 'property_id', info.property_id );
        setSetting( 'property_name', info.property_name );
        startSession( res, info.user );
        logger.info( 'Set up for ' + info.property_name + ' (' + info.property_id + ') by ' + info.user.user_id );
        res.json( { ok: true, user: info.user, property_id: info.property_id, property_name: info.property_name } );
    } catch ( err ) {
        logger.warn( 'Set-up by ' + auth.userId + ' refused by eslink: ' + err.message );
        res.status( err.unreachable ? 503 : 403 ).json( { ok: false, error: err.message } );
    }
}

/**
 * @description POST /admin/api/sign-out
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @returns {void}
 */
function signOut( req, res ) {
    const id = cookieOf( req );
    if ( id ) {
        deleteSession.run( id );
    }
    res.setHeader( 'Set-Cookie', config.session.cookie + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' );
    res.json( { ok: true } );
}

/**
 * @description Forgets the property and signs everybody out (Settings > Change property)
 * @returns {void}
 */
function resetSetup() {
    setSetting( 'property_id', null );
    setSetting( 'property_name', null );
    db.prepare( 'DELETE FROM sessions' ).run();
}

// Old sessions are removed every hour
setInterval( function() {
    pruneSessions.run( Date.now() - config.session.idleMs );
}, 3600000 ).unref();

module.exports = { requireUser, signIn, setup, signOut, resetSetup, lanIp };
