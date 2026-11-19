/**
 * Logger: console + one file per day (logs\cms-YYYY-MM-DD.log), files older than 14 days removed.
 */

'use strict';

const fs     = require( 'fs' );
const path   = require( 'path' );
const config = require( '../config/config' );

const KEEP_DAYS = 14;

fs.mkdirSync( config.paths.logs, { recursive: true } );

/**
 * @description Local date as YYYY-MM-DD
 * @param {Date} d - Date
 * @returns {string}
 */
function day( d ) {
    const p = ( n ) => String( n ).padStart( 2, '0' );
    return d.getFullYear() + '-' + p( d.getMonth() + 1 ) + '-' + p( d.getDate() );
}

/**
 * @description Writes one line
 * @param {string} level - INFO / WARN / ERROR
 * @param {string} message - Text
 * @returns {void}
 */
function write( level, message ) {
    const now  = new Date();
    const line = day( now ) + ' ' + now.toTimeString().slice( 0, 8 ) + ' [' + level + '] ' + message;
    ( level === 'ERROR' ? console.error : console.log )( line );
    try {
        fs.appendFileSync( path.join( config.paths.logs, 'cms-' + day( now ) + '.log' ), line + '\n' );
    } catch ( e ) {
        // The console line is enough when the file cannot be written
    }
}

/**
 * @description Removes log files older than KEEP_DAYS
 * @returns {void}
 */
function prune() {
    const limit = Date.now() - KEEP_DAYS * 86400000;
    try {
        fs.readdirSync( config.paths.logs ).forEach( function( f ) {
            const file = path.join( config.paths.logs, f );
            if ( /^cms-\d{4}-\d{2}-\d{2}\.log$/.test( f ) && fs.statSync( file ).mtimeMs < limit ) {
                fs.unlinkSync( file );
            }
        } );
    } catch ( e ) {
        // Nothing to prune
    }
}

prune();
setInterval( prune, 86400000 ).unref();

module.exports = {
    info:  ( m ) => write( 'INFO', m ),
    warn:  ( m ) => write( 'WARN', m ),
    error: ( m ) => write( 'ERROR', m )
};
