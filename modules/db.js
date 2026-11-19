/**
 * SQLite database (data\cms.db) - schema and small helpers.
 *
 * Tables
 *   settings        key / value (property, wallpaper, buttons revision)
 *   boxes           one row per box, by MAC
 *   box_apps        installed version of each package a box reported
 *   buttons         home buttons (Menu is not stored: the box always shows it first)
 *   apks            uploaded APKs
 *   box_apk_results last install result per box and APK
 *   sessions        signed-in web page users
 */

'use strict';

const fs       = require( 'fs' );
const Database = require( 'better-sqlite3' );
const config   = require( '../config/config' );

fs.mkdirSync( config.paths.data, { recursive: true } );

const db = new Database( config.paths.database );
db.pragma( 'journal_mode = WAL' );
db.pragma( 'foreign_keys = ON' );

db.exec( `
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boxes (
    mac                   TEXT PRIMARY KEY,
    box_name              TEXT    NOT NULL DEFAULT '',
    ip                    TEXT    NOT NULL DEFAULT '',
    launcher_version_code INTEGER NOT NULL DEFAULT 0,
    launcher_version_name TEXT    NOT NULL DEFAULT '',
    buttons_source        TEXT    NOT NULL DEFAULT 'cms',
    buttons_rev           INTEGER NOT NULL DEFAULT 0,
    firmware              TEXT    NOT NULL DEFAULT '',
    android               TEXT    NOT NULL DEFAULT '',
    first_seen            INTEGER NOT NULL,
    last_seen             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS box_apps (
    mac          TEXT    NOT NULL REFERENCES boxes( mac ) ON DELETE CASCADE,
    package      TEXT    NOT NULL,
    version_code INTEGER NOT NULL DEFAULT 0,
    version_name TEXT    NOT NULL DEFAULT '',
    updated_on   INTEGER NOT NULL,
    PRIMARY KEY ( mac, package )
);

CREATE TABLE IF NOT EXISTS buttons (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    package    TEXT    NOT NULL,
    activity   TEXT    NOT NULL DEFAULT '',
    sort       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS apks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    package      TEXT    NOT NULL,
    label        TEXT    NOT NULL DEFAULT '',
    version_code INTEGER NOT NULL,
    version_name TEXT    NOT NULL DEFAULT '',
    sha256       TEXT    NOT NULL,
    size         INTEGER NOT NULL,
    file_name    TEXT    NOT NULL,
    original     TEXT    NOT NULL DEFAULT '',
    active       INTEGER NOT NULL DEFAULT 1,
    uploaded_on  INTEGER NOT NULL,
    uploaded_by  TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS box_apk_results (
    mac        TEXT    NOT NULL REFERENCES boxes( mac ) ON DELETE CASCADE,
    apk_id     INTEGER NOT NULL REFERENCES apks( id ) ON DELETE CASCADE,
    state      TEXT    NOT NULL,
    message    TEXT    NOT NULL DEFAULT '',
    via        TEXT    NOT NULL DEFAULT 'box',
    updated_on INTEGER NOT NULL,
    PRIMARY KEY ( mac, apk_id )
);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT    PRIMARY KEY,
    user_id    TEXT    NOT NULL,
    name       TEXT    NOT NULL DEFAULT '',
    role_name  TEXT    NOT NULL DEFAULT '',
    created_on INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
);
` );

// 1.0.2: display (screen size / resolution) - what the box reports and its own override (NULL = hotel setting)
const boxColumns = db.prepare( 'PRAGMA table_info( boxes )' ).all().map( ( c ) => c.name );
[
    [ 'display_scale',  "INTEGER NOT NULL DEFAULT -1" ],      // Reported screen size %, -1 = unknown
    [ 'display_mode',   "TEXT    NOT NULL DEFAULT ''" ],      // Reported resolution
    [ 'display_modes',  "TEXT    NOT NULL DEFAULT '[]'" ],    // Reported supported resolutions (JSON)
    [ 'override_scale', "INTEGER" ],                          // This box's own screen size, NULL = hotel setting
    [ 'override_mode',  "TEXT" ]                              // This box's own resolution, NULL = hotel setting
].forEach( function( col ) {
    if ( boxColumns.indexOf( col[ 0 ] ) < 0 ) {
        db.exec( 'ALTER TABLE boxes ADD COLUMN ' + col[ 0 ] + ' ' + col[ 1 ] );
    }
} );

const getSetting = db.prepare( 'SELECT value FROM settings WHERE key = ?' );
const putSetting = db.prepare( 'INSERT INTO settings ( key, value ) VALUES ( ?, ? ) ON CONFLICT( key ) DO UPDATE SET value = excluded.value' );
const delSetting = db.prepare( 'DELETE FROM settings WHERE key = ?' );

/**
 * @description Reads a setting
 * @param {string} key - Setting name
 * @param {string} [fallback=''] - Returned when it is not set
 * @returns {string}
 */
function setting( key, fallback ) {
    const row = getSetting.get( key );
    return row ? row.value : ( fallback === undefined ? '' : fallback );
}

/**
 * @description Writes a setting; null or undefined removes it
 * @param {string} key - Setting name
 * @param {*} value - New value (stored as text)
 * @returns {void}
 */
function setSetting( key, value ) {
    if ( value === null || value === undefined ) {
        delSetting.run( key );
    } else {
        putSetting.run( key, String( value ) );
    }
}

/**
 * @description Raises the buttons revision, so every box takes the CMS list at its next check-in
 * @returns {number} New revision
 */
function bumpButtonsRev() {
    const rev = Number( setting( 'buttons_rev', '0' ) ) + 1;
    setSetting( 'buttons_rev', rev );
    return rev;
}

/**
 * @description The screen size / resolution a box should have: its own override, else the hotel setting
 * @param {object} box - boxes row (override_scale / override_mode)
 * @returns {object} { scale: 80-100 or 0 = leave as it is, mode: name or '' = leave as it is }
 */
function displayTarget( box ) {
    const hotelScale = Number( setting( 'display_scale', '0' ) ) || 0;
    let hotelMode    = setting( 'display_mode' );
    // The hotel resolution is skipped on a box whose TV does not report it (the box keeps its own)
    let modes = [];
    try { modes = JSON.parse( ( box && box.display_modes ) || '[]' ); } catch ( e ) { modes = []; }
    if ( hotelMode && Array.isArray( modes ) && modes.length > 0 && modes.indexOf( hotelMode ) < 0 ) {
        hotelMode = '';
    }
    return {
        scale: box && box.override_scale !== null && box.override_scale !== undefined ? box.override_scale : hotelScale,
        mode:  box && box.override_mode !== null && box.override_mode !== undefined ? box.override_mode : hotelMode
    };
}

module.exports = { db, setting, setSetting, bumpButtonsRev, displayTarget };
