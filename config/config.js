/**
 * estv-custom-launcher-cms configuration.
 *
 * There is no config file on the hotel PC. The property is chosen on the CMS page at first sign-in and kept in
 * the database (data\cms.db). Only the eslink address is built in; ESLINK_API_URL and CMS_PORT may be set as
 * environment variables on a development PC.
 */

'use strict';

const path = require( 'path' );
const pkg  = require( '../package.json' );

/** Folder of the app (server.js) */
const root = path.resolve( __dirname, '..' );

/** Data folder (CMS_DATA_DIR only for the tests) */
const data = process.env.CMS_DATA_DIR ? path.resolve( process.env.CMS_DATA_DIR ) : path.join( root, 'data' );

/**
 * @description Adds a trailing slash to a base URL
 * @param {string} url - Base URL
 * @returns {string}
 */
function withSlash( url ) {
    return url.endsWith( '/' ) ? url : url + '/';
}

module.exports = {

    version: pkg.version,
    root:    root,

    /** Web page + box API port (boxes default to 172.19.0.3:4053) */
    port: Number( process.env.CMS_PORT ) || 4053,

    paths: {
        data:      data,
        database:  path.join( data, 'cms.db' ),
        wallpaper: path.join( data, 'wallpaper' ),
        apks:      path.join( data, 'apks' ),
        uploads:   path.join( data, 'uploads' ),             // Files being uploaded, moved once checked
        logs:      process.env.CMS_DATA_DIR ? path.join( data, 'logs' ) : path.join( root, 'logs' ),
        public:    path.join( root, 'public' )
    },

    eslink: {
        baseUrl:   withSlash( process.env.ESLINK_API_URL || 'https://eslink.online/' ),
        timeout:   20000,
        // Request parameter that carries a Scodezy token (Apache drops headers with underscores)
        tokenName: 'xAwBo5Re9a'
    },

    session: {
        cookie: 'cms_session',
        idleMs: 12 * 60 * 60 * 1000          // Signed out after 12 hours without a request
    },

    boxes: {
        intervalSec: 300,                    // Check-in interval told to the boxes
        onlineMs:    10 * 60 * 1000,         // Green: seen in the last 10 minutes
        lateMs:      30 * 60 * 1000          // Amber until 30 minutes, then red
    },

    limits: {
        wallpaperBytes: 10 * 1024 * 1024,
        apkBytes:       300 * 1024 * 1024
    },

    /** Port a box's network ADB listens on (backup install from this PC) */
    adbPort: 5555
};
