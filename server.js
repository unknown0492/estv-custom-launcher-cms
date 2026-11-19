/**
 * estv-custom-launcher-cms - the hotel's CMS for the esTV Custom Launcher boxes.
 *
 *   /api/box/*     box check-in, wallpaper and APK downloads (docs/box-protocol.md)
 *   /admin/api/*   web page API (eslink sign-in)
 *   /              web page
 *
 * Runs in PM2 ("estv-custom-launcher-cms"), started with Windows. Port 4053 (CMS_PORT on a development PC).
 */

'use strict';

const path    = require( 'path' );
const express = require( 'express' );
const config  = require( './config/config' );
const logger  = require( './modules/logger' );
const { setting } = require( './modules/db' );

const app = express();
app.disable( 'x-powered-by' );
app.set( 'trust proxy', false );

// Basic hardening of every answer
app.use( function( req, res, next ) {
    res.setHeader( 'X-Content-Type-Options', 'nosniff' );
    res.setHeader( 'X-Frame-Options', 'DENY' );
    res.setHeader( 'Referrer-Policy', 'no-referrer' );
    next();
} );

app.use( '/api/box', require( './routes/boxApi' ) );
app.use( '/admin/api', require( './routes/adminApi' ) );

// Front-end libraries from node_modules (no internet needed on the hotel LAN)
const nm = path.join( config.root, 'node_modules' );
app.use( '/vendor/bootstrap', express.static( path.join( nm, 'bootstrap', 'dist' ), { maxAge: '7d' } ) );
app.use( '/vendor/bootstrap-icons', express.static( path.join( nm, 'bootstrap-icons', 'font' ), { maxAge: '7d' } ) );
app.use( '/vendor/jquery', express.static( path.join( nm, 'jquery', 'dist' ), { maxAge: '7d' } ) );
app.use( express.static( config.paths.public, { index: 'index.html', maxAge: 0 } ) );

app.use( function( req, res ) {
    res.status( 404 ).json( { ok: false, error: 'Not found' } );
} );

// Errors (e.g. a malformed JSON body): a short JSON answer, never a stack trace
app.use( function( err, req, res, next ) {        // eslint-disable-line no-unused-vars
    const status = err.status || err.statusCode || 500;
    if ( status >= 500 ) {
        logger.error( req.method + ' ' + req.originalUrl + ': ' + ( err.stack || err.message ) );
    }
    res.status( status ).json( { ok: false, error: status === 400 ? 'The request is not valid' : 'Something went wrong on the CMS' } );
} );

const server = app.listen( config.port, function() {
    const prop = setting( 'property_name' );
    logger.info( 'estv-custom-launcher-cms ' + config.version + ' listening on port ' + config.port
               + ( prop ? ' (' + prop + ')' : ' (not set up yet - sign in on the web page)' ) );
} );

server.on( 'error', function( err ) {
    logger.error( 'Cannot listen on port ' + config.port + ': ' + err.message );
    process.exit( 1 );
} );

/**
 * @description Closes the server on PM2 stop / restart
 * @param {string} signal - Signal name
 * @returns {void}
 */
function shutdown( signal ) {
    logger.info( 'Stopping (' + signal + ')' );
    server.close( () => process.exit( 0 ) );
    setTimeout( () => process.exit( 0 ), 3000 ).unref();
}
process.on( 'SIGINT', shutdown );
process.on( 'SIGTERM', shutdown );
