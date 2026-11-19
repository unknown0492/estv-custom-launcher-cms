/**
 * eslink.online calls. The CMS keeps no eslink secret: people sign in to the CMS page with their eslink
 * account, the CMS signs them in to eslink (scodezy_login) and uses that user token for the two Custom Launcher
 * functions. The token is not kept after the sign-in.
 */

'use strict';

const axios  = require( 'axios' );
const config = require( '../config/config' );

/**
 * @description Error for "eslink cannot be reached" (as opposed to eslink refusing)
 * @param {string} message - Text
 * @returns {Error}
 */
function unreachable( message ) {
    const err = new Error( message );
    err.unreachable = true;
    return err;
}

/**
 * @description POSTs a form to eslink's webservice.php and returns the first answer object
 * @param {object} fields - Form fields, including what_do_you_want
 * @returns {Promise<object>} { type, info }
 * @throws {Error} unreachable = true when eslink cannot be reached or answers something that is not JSON
 */
async function post( fields ) {
    const form = new URLSearchParams();
    Object.keys( fields ).forEach( ( k ) => form.append( k, fields[ k ] === undefined ? '' : String( fields[ k ] ) ) );

    let response;
    try {
        response = await axios.post( config.eslink.baseUrl + 'webservice.php', form.toString(), {
            timeout: config.eslink.timeout,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'estv-custom-launcher-cms/' + config.version },
            validateStatus: () => true,
            transformResponse: [ ( d ) => d ]          // Parsed below, so HTML errors are caught
        } );
    } catch ( err ) {
        throw unreachable( 'eslink.online cannot be reached (' + ( err.code || err.message ) + ')' );
    }

    let body;
    try {
        body = JSON.parse( response.data );
    } catch ( e ) {
        throw unreachable( 'eslink.online gave an unexpected answer (HTTP ' + response.status + ')' );
    }
    if ( Array.isArray( body ) ) {
        body = body[ 0 ];
    }
    if ( !body || typeof body !== 'object' ) {
        throw unreachable( 'eslink.online gave an empty answer' );
    }
    return body;
}

/**
 * @description Message text of an eslink answer
 * @param {object} answer - { type, info }
 * @returns {string}
 */
function messageOf( answer ) {
    const info = answer && answer.info;
    if ( typeof info === 'string' ) {
        return info;
    }
    if ( info && typeof info.message === 'string' ) {
        return info.message;
    }
    return 'eslink.online refused the request';
}

/**
 * @description Signs a person in to eslink
 * @param {string} userId - eslink user ID
 * @param {string} password - Password
 * @returns {Promise<string>} User token
 * @throws {Error} With eslink's message when refused; unreachable = true when eslink cannot be reached
 */
async function userSignIn( userId, password ) {
    const answer = await post( { what_do_you_want: 'scodezy_login', user_id: userId, password: password } );
    const token  = answer.type === 'success' && answer.info ? answer.info[ config.eslink.tokenName ] : '';
    if ( !token ) {
        throw new Error( answer.type === 'error' ? messageOf( answer ) : 'Wrong user ID or password' );
    }
    return token;
}

/**
 * @description Calls an eslink function with a user token
 * @param {string} token - From userSignIn
 * @param {string} fn - what_do_you_want
 * @param {object} [params] - Other fields
 * @returns {Promise<*>} info of a success answer
 * @throws {Error} With eslink's message when refused
 */
async function callWithToken( token, fn, params ) {
    const fields = Object.assign( { what_do_you_want: fn }, params || {} );
    fields[ config.eslink.tokenName ] = token;
    const answer = await post( fields );
    if ( answer.type !== 'success' ) {
        throw new Error( messageOf( answer ) );
    }
    return answer.info;
}

/**
 * @description Properties the signed-in person may set this CMS up for
 * @param {string} token - User token
 * @returns {Promise<Array>} [ { property_id, property_name, cms_host, cms_port } ]
 */
function listProperties( token ) {
    return callWithToken( token, 'eslink_custom_launcher_cms_properties' );
}

/**
 * @description Checks that the person may use this hotel's CMS, and tells eslink this PC's address
 * @param {string} token - User token
 * @param {string} propertyId - The CMS's property
 * @param {string} cmsIp - This PC's LAN IP
 * @returns {Promise<object>} { user: { user_id, name, role_name }, property_id, property_name, cms_host, cms_port }
 */
function cmsSignIn( token, propertyId, cmsIp ) {
    return callWithToken( token, 'eslink_custom_launcher_cms_sign_in', {
        property_id: propertyId,
        cms_ip:      cmsIp,
        cms_port:    config.port,
        cms_version: config.version
    } );
}

module.exports = { userSignIn, listProperties, cmsSignIn };
