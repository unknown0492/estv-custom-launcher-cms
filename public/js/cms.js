/**
 * Custom Launcher CMS - web page.
 *
 * Views: sign-in, first set-up (choose the property), app. Pages in the app: Boxes, Wallpaper, Home buttons,
 * APK updates, Settings (location hash). Talks to /admin/api with the session cookie.
 */

/* global $, bootstrap */

var Cms = {

    page: '',              // Page shown
    boxes: [],             // Last /boxes answer
    boxMeta: {},           // now / online_ms / late_ms of that answer
    sort: { key: 'box_name', dir: 1 },
    buttons: [],           // Home buttons being edited
    buttonsDirty: false,
    wallpaperUrl: '',      // For the buttons preview background
    setupMode: false,      // First set-up: the sign-in form also shows the property choice
    refreshTimer: null,

    /**
     * @description Starts the page: signed in -> app, else sign-in
     * @returns {void}
     */
    init: function(){
        Cms.bind();
        Cms.api( 'GET', 'me' ).done( function( info ){
            Cms.showApp( info );
        }).fail( function(){
            Cms.showSignIn();
        });
    },

    /**
     * @description Calls the CMS API
     * @param {string} method - GET / POST / PUT / PATCH / DELETE
     * @param {string} path - Path under /admin/api/
     * @param {Object|FormData} [data] - JSON body, or FormData for uploads
     * @returns {jQuery.Deferred} Resolved with the answer; rejected with the error text (signed out -> sign-in view)
     */
    api: function( method, path, data ){
        var d    = $.Deferred();
        var opts = { url: '/admin/api/' + path, type: method, dataType: 'json' };
        if( data instanceof FormData ){
            opts.data        = data;
            opts.processData = false;
            opts.contentType = false;
        }
        else if( data !== undefined ){
            opts.data        = JSON.stringify( data );
            opts.contentType = 'application/json';
        }
        $.ajax( opts ).done( function( answer ){
            if( answer && answer.ok ){
                d.resolve( answer );
            }
            else{
                d.reject( ( answer && answer.error ) || 'The CMS refused the request' );
            }
        }).fail( function( xhr ){
            var answer = xhr.responseJSON || {};
            if( xhr.status === 401 && answer.signed_out && path !== 'me' && path !== 'sign-in' && path !== 'setup' ){
                Cms.toast( 'Your session has ended. Please sign in again.', 'warning' );
                Cms.showSignIn();
            }
            d.reject( answer.error || ( xhr.status === 0 ? 'The CMS cannot be reached' : 'Error ' + xhr.status ) );
        });
        return d.promise();
    },

    /**
     * @description All event handlers
     * @returns {void}
     */
    bind: function(){
        $( '#form_sign_in' ).on( 'submit', function( e ){ e.preventDefault(); Cms.signIn(); } );
        $( '#btn_sign_out' ).on( 'click', function(){
            Cms.api( 'POST', 'sign-out' ).always( function(){ Cms.showSignIn(); } );
        });
        $( window ).on( 'hashchange', function(){ Cms.go( location.hash.slice( 1 ) ); } );

        // Boxes
        $( '#input_box_search' ).on( 'input', function(){ Cms.renderBoxes(); } );
        $( '#btn_boxes_reload' ).on( 'click', function(){ Cms.loadBoxes(); } );
        $( '#btn_boxes_csv' ).on( 'click', function(){ Cms.boxesCsv(); } );
        $( '.cms-sort' ).on( 'click', function(){
            var key = $( this ).data( 'sort' );
            Cms.sort = { key: key, dir: Cms.sort.key === key ? -Cms.sort.dir : 1 };
            Cms.renderBoxes();
        });
        $( '#box_rows' ).on( 'click', '.cms-box-remove', function(){
            var mac = $( this ).data( 'mac' );
            Cms.confirm( 'Remove box', 'Remove ' + mac + ' from the list? If the box still exists it comes back at its next check-in.', function(){
                Cms.api( 'DELETE', 'boxes/' + encodeURIComponent( mac ) ).done( function(){ Cms.loadBoxes(); } ).fail( Cms.toastError );
            });
        });

        // Wallpaper
        $( '#btn_wallpaper_upload' ).on( 'click', function(){ Cms.uploadWallpaper( $( this ) ); } );
        $( '#btn_wallpaper_reset' ).on( 'click', function(){
            Cms.confirm( 'Use the built-in wallpaper', 'The boxes go back to the launcher\'s built-in wallpaper within 5 minutes.', function(){
                Cms.api( 'DELETE', 'wallpaper' ).done( function(){ Cms.toast( 'The boxes will show the built-in wallpaper', 'success' ); Cms.loadWallpaper(); } ).fail( Cms.toastError );
            });
        });

        // Home buttons
        $( '#btn_button_add' ).on( 'click', function(){
            if( Cms.buttons.length >= 12 ){
                Cms.toast( 'At most 12 buttons', 'warning' );
                return;
            }
            Cms.readButtons();
            Cms.buttons.push( { name: '', package: '', activity: '' } );
            Cms.renderButtons();
            Cms.setButtonsDirty( true );
            $( '#button_rows tr:last .cms-btn-name' ).trigger( 'focus' );
        });
        $( '#btn_buttons_save' ).on( 'click', function(){ Cms.saveButtons( $( this ) ); } );
        $( '#button_rows' ).on( 'input', 'input', function(){
            Cms.readButtons();
            Cms.renderPreview();
            Cms.setButtonsDirty( true );
        });
        $( '#button_rows' ).on( 'click', '[data-move]', function(){
            Cms.readButtons();
            var i = +$( this ).closest( 'tr' ).data( 'index' );
            var j = i + ( +$( this ).data( 'move' ) );
            if( j < 0 || j >= Cms.buttons.length ){
                return;
            }
            var t = Cms.buttons[ i ]; Cms.buttons[ i ] = Cms.buttons[ j ]; Cms.buttons[ j ] = t;
            Cms.renderButtons();
            Cms.setButtonsDirty( true );
        });
        $( '#button_rows' ).on( 'click', '.cms-btn-delete', function(){
            Cms.readButtons();
            Cms.buttons.splice( +$( this ).closest( 'tr' ).data( 'index' ), 1 );
            Cms.renderButtons();
            Cms.setButtonsDirty( true );
        });
        $( window ).on( 'beforeunload', function(){
            if( Cms.buttonsDirty ){
                return 'You have unsaved changes.';
            }
        });

        // APKs
        $( '#btn_apk_upload' ).on( 'click', function(){ Cms.uploadApk( $( this ) ); } );
        $( '#apk_list' ).on( 'change', '.cms-apk-active', function(){
            var id = $( this ).data( 'id' );
            Cms.api( 'PATCH', 'apks/' + id, { active: this.checked } ).done( function(){ Cms.loadApks(); } ).fail( function( e ){ Cms.toastError( e ); Cms.loadApks(); } );
        });
        $( '#apk_list' ).on( 'click', '.cms-apk-delete', function(){
            var id = $( this ).data( 'id' );
            Cms.confirm( 'Delete APK', 'Delete this APK from the CMS? Boxes that installed it keep it.', function(){
                Cms.api( 'DELETE', 'apks/' + id ).done( function(){ Cms.loadApks(); } ).fail( Cms.toastError );
            });
        });
        $( '#apk_list' ).on( 'click', '.cms-apk-adb', function(){
            var $b = $( this );
            Cms.busy( $b, true );
            Cms.api( 'POST', 'apks/' + $b.data( 'id' ) + '/adb', { mac: $b.data( 'mac' ) } ).done( function( a ){
                Cms.toast( a.message, 'success' );
            }).fail( Cms.toastError ).always( function(){
                Cms.busy( $b, false );
                Cms.loadApks();
            });
        });

        // Settings
        $( '#btn_adb_save' ).on( 'click', function(){
            Cms.api( 'POST', 'settings', { adb_path: $.trim( $( '#input_adb_path' ).val() ) } ).done( function(){
                Cms.toast( 'Saved', 'success' );
                Cms.loadSettings();
            }).fail( Cms.toastError );
        });
        $( '#btn_change_property' ).on( 'click', function(){
            Cms.confirm( 'Change property', 'Everybody is signed out and the next person to sign in chooses the property again. Boxes keep working with the current settings meanwhile.', function(){
                Cms.api( 'POST', 'settings/change-property' ).done( function(){ Cms.showSignIn(); } ).fail( Cms.toastError );
            });
        });
    },

    // ==================== Views ====================

    /**
     * @description Shows the sign-in form
     * @returns {void}
     */
    showSignIn: function(){
        clearInterval( Cms.refreshTimer );
        $( '#view_app' ).addClass( 'd-none' );
        $( '#view_sign_in' ).removeClass( 'd-none' );
        $( '#input_password' ).val( '' );
        $( '#sign_in_error' ).addClass( 'd-none' );
        Cms.setSetupMode( false );
        Cms.api( 'GET', 'state' ).done( function( s ){
            $( '#sign_in_property' ).text( s.set_up ? s.property_name : 'Not set up yet - sign in with eslink to choose the hotel' );
            $( '#sign_in_version' ).text( 'Version ' + s.version );
        });
        $( '#input_user_id' ).trigger( 'focus' );
    },

    /**
     * @description Shows the app for a signed-in person
     * @param {Object} info - { user, property_name }
     * @returns {void}
     */
    showApp: function( info ){
        $( '#view_sign_in' ).addClass( 'd-none' );
        $( '#view_app' ).removeClass( 'd-none' );
        $( '#nav_user' ).text( info.user.name || info.user.user_id );
        $( '#nav_property' ).text( info.property_name || '' ).attr( 'title', info.property_name || '' );
        Cms.page = '';
        Cms.go( location.hash.slice( 1 ) );
        clearInterval( Cms.refreshTimer );
        Cms.refreshTimer = setInterval( function(){
            if( Cms.page === 'boxes' ){ Cms.loadBoxes(); }
            if( Cms.page === 'apks' ){ Cms.loadApks(); }
        }, 60000 );
    },

    /**
     * @description Sign-in form submitted: signs in, or - on a new CMS once the property list is shown - links the
     *              CMS to the chosen property (the user ID / password are sent again; the CMS keeps nothing between)
     * @returns {void}
     */
    signIn: function(){
        var $b    = $( '#btn_sign_in' );
        var creds = { user_id: $.trim( $( '#input_user_id' ).val() ), password: $( '#input_password' ).val() };
        $( '#sign_in_error' ).addClass( 'd-none' );
        Cms.busy( $b, true );

        var request = Cms.setupMode
            ? Cms.api( 'POST', 'setup', $.extend( { property_id: $( '#select_setup_property' ).val() }, creds ) )
            : Cms.api( 'POST', 'sign-in', creds );
        request.done( function( a ){
            if( a.needs_setup ){
                Cms.showSetup( a );
                return;
            }
            $( '#input_password' ).val( '' );
            Cms.setSetupMode( false );
            Cms.api( 'GET', 'me' ).done( Cms.showApp ).fail( Cms.toastError );
        }).fail( function( e ){
            $( '#sign_in_error' ).text( e ).removeClass( 'd-none' );
        }).always( function(){ Cms.busy( $b, false ); } );
    },

    /**
     * @description Shows the property choice of the first set-up in the sign-in form
     * @param {Object} a - { properties }
     * @returns {void}
     */
    showSetup: function( a ){
        var $s = $( '#select_setup_property' ).empty();
        if( !a.properties.length ){
            $s.append( $( '<option value="">' ).text( 'Your eslink account has no properties' ) );
        }
        a.properties.forEach( function( p ){
            $s.append( $( '<option>' ).val( p.property_id ).text( p.property_name + ' (' + p.property_id + ')' ) );
        });
        Cms.setSetupMode( true );
        $s.trigger( 'focus' );
    },

    /**
     * @description Switches the sign-in form between "Sign in" and the first set-up ("Use this property")
     * @param {boolean} on - Set-up mode
     * @returns {void}
     */
    setSetupMode: function( on ){
        Cms.setupMode = on;
        $( '#block_setup_property' ).toggleClass( 'd-none', !on );
        $( '#btn_sign_in_label' ).text( on ? 'Use this property' : 'Sign in' );
    },

    /**
     * @description Shows a page and loads its data
     * @param {string} page - boxes / wallpaper / buttons / apks / settings
     * @returns {void}
     */
    go: function( page ){
        if( [ 'boxes', 'wallpaper', 'buttons', 'apks', 'settings' ].indexOf( page ) < 0 ){
            page = 'boxes';
        }
        if( Cms.page === 'buttons' && page !== 'buttons' && Cms.buttonsDirty && !window.confirm( 'Leave without saving the home buttons?' ) ){
            location.hash = 'buttons';
            return;
        }
        if( page === 'buttons' && Cms.page !== 'buttons' ){
            Cms.setButtonsDirty( false );
        }
        Cms.page = page;
        $( '.cms-page' ).addClass( 'd-none' );
        $( '#page_' + page ).removeClass( 'd-none' );
        $( '#nav_pages .nav-link' ).removeClass( 'active' ).filter( '[data-page="' + page + '"]' ).addClass( 'active' );
        bootstrap.Collapse.getInstance( '#nav_main' ) && bootstrap.Collapse.getInstance( '#nav_main' ).hide();
        ( { boxes: Cms.loadBoxes, wallpaper: Cms.loadWallpaper, buttons: Cms.loadButtons, apks: Cms.loadApks, settings: Cms.loadSettings } )[ page ]();
    },

    // ==================== Boxes ====================

    /**
     * @description Loads the box list
     * @returns {void}
     */
    loadBoxes: function(){
        Cms.api( 'GET', 'boxes' ).done( function( a ){
            Cms.boxes   = a.boxes;
            Cms.boxMeta = { now: a.now, online: a.online_ms, late: a.late_ms };
            Cms.renderBoxes();
        }).fail( Cms.toastError );
    },

    /**
     * @description Status of a box from its last check-in
     * @param {Object} b - Box
     * @returns {Object} { cls, text }
     */
    seen: function( b ){
        var age = Cms.boxMeta.now - b.last_seen;
        if( age < Cms.boxMeta.online ){ return { cls: 'bg-success', text: 'Online' }; }
        if( age < Cms.boxMeta.late ){ return { cls: 'bg-warning', text: 'Late' }; }
        return { cls: 'bg-danger', text: 'Offline' };
    },

    /**
     * @description Fills the box table (search + sort) and the counters
     * @returns {void}
     */
    renderBoxes: function(){
        var esc = Cms.escape;
        var q   = $.trim( $( '#input_box_search' ).val() ).toLowerCase();
        var key = Cms.sort.key, dir = Cms.sort.dir;
        var list = Cms.boxes.filter( function( b ){
            return !q || ( b.box_name + ' ' + b.mac + ' ' + b.ip ).toLowerCase().indexOf( q ) >= 0;
        }).sort( function( x, y ){
            var a = x[ key ], c = y[ key ];
            if( key === 'box_name' && ( !a ) !== ( !c ) ){
                return a ? -1 : 1;                                          // Boxes without a name last
            }
            if( key === 'box_name' ){
                a = a.toLowerCase(); c = c.toLowerCase();
            }
            if( key === 'ip' ){
                a = Cms.ipSortKey( a ); c = Cms.ipSortKey( c );
            }
            return ( a < c ? -1 : a > c ? 1 : 0 ) * dir;
        });

        $( '.cms-sort' ).removeClass( 'asc desc' ).filter( '[data-sort="' + key + '"]' ).addClass( dir > 0 ? 'asc' : 'desc' );

        var online = 0, offline = 0, pending = 0;
        Cms.boxes.forEach( function( b ){
            var s = Cms.seen( b ).text;
            if( s === 'Online' ){ online++; }
            if( s === 'Offline' ){ offline++; }
            if( b.updates.some( function( u ){ return u.state !== 'up_to_date'; } ) ){ pending++; }
        });
        $( '#count_total' ).text( Cms.boxes.length );
        $( '#count_online' ).text( online );
        $( '#count_offline' ).text( offline );
        $( '#count_pending' ).text( pending );

        if( !list.length ){
            $( '#box_rows' ).html( '<tr><td colspan="8" class="text-center text-body-secondary py-5">' +
                ( Cms.boxes.length ? 'No box matches the search.' : 'No box has checked in yet. Boxes appear here at their first check-in (CMS IP set in the launcher\'s Secret Menu).' ) + '</td></tr>' );
            return;
        }

        $( '#box_rows' ).html( list.map( function( b ){
            var s       = Cms.seen( b );
            var apps    = b.apps.map( function( a ){
                return '<div class="text-nowrap"><span class="text-body-secondary">' + esc( a.package ) + '</span> ' + ( a.version ? esc( a.version ) : '<span class="text-danger">not installed</span>' ) + '</div>';
            }).join( '' ) || '<span class="text-body-secondary">-</span>';
            var waiting = b.updates.filter( function( u ){ return u.state === 'pending'; } );
            var failed  = b.updates.filter( function( u ){ return u.state === 'failed'; } );
            var upd     = failed.length ? '<span class="badge text-bg-danger" title="' + esc( failed.map( function( u ){ return u.package + ': ' + u.message; } ).join( '\n' ) ) + '">Failed ' + failed.length + '</span> ' : '';
            upd += waiting.length ? '<span class="badge text-bg-warning" title="' + esc( waiting.map( function( u ){ return u.package + ' ' + ( u.installed || '-' ) + ' → ' + u.target; } ).join( '\n' ) ) + '">Waiting ' + waiting.length + '</span>' : '';
            if( !upd ){
                upd = b.updates.length ? '<span class="badge text-bg-success">Up to date</span>' : '<span class="text-body-secondary">-</span>';
            }
            return '<tr>' +
                '<td class="fw-semibold">' + ( b.box_name ? esc( b.box_name ) : '<span class="text-body-secondary fw-normal">No name</span>' ) +
                    ( b.buttons_source === 'local' ? ' <span class="badge text-bg-light border" title="Home buttons were changed on this box">local buttons</span>' : '' ) + '</td>' +
                '<td class="cms-mono">' + esc( b.mac ) + '</td>' +
                '<td class="cms-mono">' + esc( b.ip ) + '</td>' +
                '<td class="text-nowrap" title="' + esc( Cms.time( b.last_seen ) ) + '"><span class="cms-dot ' + s.cls + '"></span>' + esc( Cms.ago( b.last_seen ) ) + '</td>' +
                '<td>' + ( b.launcher ? esc( b.launcher ) : '-' ) + '</td>' +
                '<td class="small">' + apps + '</td>' +
                '<td>' + upd + '</td>' +
                '<td class="text-end"><button class="btn btn-sm btn-outline-danger cms-box-remove" data-mac="' + esc( b.mac ) + '" title="Remove from the list"><i class="bi bi-trash"></i></button></td>' +
            '</tr>';
        }).join( '' ) );
    },

    /**
     * @description Sortable form of an IPv4 address
     * @param {string} ip - Address
     * @returns {string}
     */
    ipSortKey: function( ip ){
        return String( ip || '' ).split( '.' ).map( function( p ){ return ( '000' + p ).slice( -3 ); } ).join( '.' );
    },

    /**
     * @description Downloads the box list as CSV
     * @returns {void}
     */
    boxesCsv: function(){
        var cell = function( v ){ return '"' + String( v === undefined || v === null ? '' : v ).replace( /"/g, '""' ) + '"'; };
        var rows = [ [ 'Box name', 'MAC', 'IP', 'Last seen', 'Status', 'Launcher', 'Button apps', 'Firmware', 'Android' ] ];
        Cms.boxes.forEach( function( b ){
            rows.push( [ b.box_name, b.mac, b.ip, Cms.time( b.last_seen ), Cms.seen( b ).text, b.launcher,
                         b.apps.map( function( a ){ return a.package + ' ' + ( a.version || 'not installed' ); } ).join( '; ' ), b.firmware, b.android ] );
        });
        var blob = new Blob( [ rows.map( function( r ){ return r.map( cell ).join( ',' ); } ).join( '\r\n' ) ], { type: 'text/csv' } );
        var a    = $( '<a>' ).attr( { href: URL.createObjectURL( blob ), download: 'boxes.csv' } ).appendTo( 'body' );
        a[ 0 ].click();
        a.remove();
    },

    // ==================== Wallpaper ====================

    /**
     * @description Loads the current wallpaper
     * @returns {void}
     */
    loadWallpaper: function(){
        Cms.api( 'GET', 'wallpaper' ).done( function( a ){
            var w = a.wallpaper;
            Cms.wallpaperUrl = w ? w.url : '';
            $( '#wallpaper_img' ).toggleClass( 'd-none', !w ).attr( 'src', w ? w.url : '' );
            $( '#wallpaper_empty' ).toggleClass( 'd-none', !!w );
            $( '#btn_wallpaper_reset' ).prop( 'disabled', !w );
            $( '#wallpaper_info' ).text( w ? ( w.original || 'Picture' ) + ' · ' + Cms.size( w.size ) + ' · uploaded ' + Cms.time( w.uploaded_on ) + ' by ' + w.uploaded_by : '' );
        }).fail( Cms.toastError );
    },

    /**
     * @description Uploads the chosen picture
     * @param {jQuery} $b - Upload button
     * @returns {void}
     */
    uploadWallpaper: function( $b ){
        var file = $( '#input_wallpaper' )[ 0 ].files[ 0 ];
        if( !file ){
            Cms.toast( 'Choose a JPG or PNG picture first', 'warning' );
            return;
        }
        var fd = new FormData();
        fd.append( 'file', file );
        Cms.busy( $b, true );
        Cms.api( 'POST', 'wallpaper', fd ).done( function(){
            Cms.toast( 'Wallpaper uploaded. Boxes show it within 5 minutes.', 'success' );
            $( '#input_wallpaper' ).val( '' );
            Cms.loadWallpaper();
        }).fail( Cms.toastError ).always( function(){ Cms.busy( $b, false ); } );
    },

    // ==================== Home buttons ====================

    /**
     * @description Loads the home buttons (and the wallpaper for the preview)
     * @returns {void}
     */
    loadButtons: function(){
        Cms.api( 'GET', 'wallpaper' ).done( function( a ){
            Cms.wallpaperUrl = a.wallpaper ? a.wallpaper.url : '';
            Cms.renderPreview();
        });
        Cms.api( 'GET', 'buttons' ).done( function( a ){
            Cms.buttons = a.buttons;
            Cms.renderButtons();
            Cms.setButtonsDirty( false );
        }).fail( Cms.toastError );
    },

    /**
     * @description Reads the button rows into Cms.buttons
     * @returns {void}
     */
    readButtons: function(){
        Cms.buttons = $( '#button_rows tr[data-index]' ).map( function(){
            var $r = $( this );
            return { name: $.trim( $r.find( '.cms-btn-name' ).val() ), package: $.trim( $r.find( '.cms-btn-package' ).val() ), activity: $.trim( $r.find( '.cms-btn-activity' ).val() ) };
        }).get();
    },

    /**
     * @description Fills the button rows from Cms.buttons
     * @returns {void}
     */
    renderButtons: function(){
        var esc = Cms.escape;
        var n   = Cms.buttons.length;
        if( !n ){
            $( '#button_rows' ).html( '<tr><td colspan="5" class="text-center text-body-secondary py-4">No buttons: the boxes show only "Menu". Add one.</td></tr>' );
        }
        else{
            $( '#button_rows' ).html( Cms.buttons.map( function( b, i ){
                return '<tr data-index="' + i + '">' +
                    '<td><div class="btn-group btn-group-sm">' +
                        '<button class="btn btn-outline-secondary" data-move="-1" title="Move up"' + ( i === 0 ? ' disabled' : '' ) + '><i class="bi bi-arrow-up"></i></button>' +
                        '<button class="btn btn-outline-secondary" data-move="1" title="Move down"' + ( i === n - 1 ? ' disabled' : '' ) + '><i class="bi bi-arrow-down"></i></button>' +
                    '</div></td>' +
                    '<td><input type="text" class="form-control form-control-sm cms-btn-name" maxlength="30" placeholder="Movies" value="' + esc( b.name ) + '"></td>' +
                    '<td><input type="text" class="form-control form-control-sm cms-mono cms-btn-package" maxlength="150" placeholder="com.example.app" value="' + esc( b.package ) + '"></td>' +
                    '<td><input type="text" class="form-control form-control-sm cms-mono cms-btn-activity" maxlength="200" placeholder=".MainActivity" value="' + esc( b.activity ) + '"></td>' +
                    '<td class="text-end"><button class="btn btn-sm btn-outline-danger cms-btn-delete" title="Remove"><i class="bi bi-trash"></i></button></td>' +
                '</tr>';
            }).join( '' ) );
        }
        Cms.renderPreview();
    },

    /**
     * @description Draws the small TV preview: Menu + the buttons on the wallpaper
     * @returns {void}
     */
    renderPreview: function(){
        var esc = Cms.escape;
        $( '#buttons_preview' ).css( 'background-image', Cms.wallpaperUrl ? 'url("' + Cms.wallpaperUrl + '")' : '' ).html(
            '<div class="cms-tv-button cms-tv-menu">Menu</div>' +
            Cms.buttons.map( function( b ){ return '<div class="cms-tv-button">' + ( b.name ? esc( b.name ) : '…' ) + '</div>'; } ).join( '' ) );
    },

    /**
     * @description Marks the buttons as changed / saved
     * @param {boolean} dirty - Changed since the last save
     * @returns {void}
     */
    setButtonsDirty: function( dirty ){
        Cms.buttonsDirty = dirty;
        $( '#btn_buttons_save' ).prop( 'disabled', !dirty );
    },

    /**
     * @description Saves the button list
     * @param {jQuery} $b - Save button
     * @returns {void}
     */
    saveButtons: function( $b ){
        Cms.readButtons();
        Cms.busy( $b, true );
        Cms.api( 'PUT', 'buttons', { buttons: Cms.buttons } ).done( function(){
            Cms.setButtonsDirty( false );
            Cms.toast( 'Saved. Every box takes these buttons within 5 minutes.', 'success' );
        }).fail( Cms.toastError ).always( function(){
            Cms.busy( $b, false );
            $b.prop( 'disabled', !Cms.buttonsDirty );
        });
    },

    // ==================== APKs ====================

    /**
     * @description Loads the APK list with per-box progress
     * @returns {void}
     */
    loadApks: function(){
        Cms.api( 'GET', 'apks' ).done( function( a ){ Cms.renderApks( a.apks ); } ).fail( Cms.toastError );
    },

    /**
     * @description Draws one card per APK
     * @param {Array} apks - From /apks
     * @returns {void}
     */
    renderApks: function( apks ){
        var esc  = Cms.escape;
        var open = $( '#apk_list .collapse.show' ).map( function(){ return this.id; } ).get();   // Keep open lists open
        if( !apks.length ){
            $( '#apk_list' ).html( '<div class="card"><div class="card-body text-center text-body-secondary py-5">No APK uploaded yet.</div></div>' );
            return;
        }
        $( '#apk_list' ).html( apks.map( function( p ){
            var total = p.boxes.length;
            var pct   = total ? Math.round( p.done * 100 / total ) : 0;
            var kind  = p.package === 'com.excel.estvlauncher.custom' ? 'Launcher' : 'App';
            var rows  = p.boxes.map( function( b ){
                var badge = b.state === 'up_to_date' ? '<span class="badge text-bg-success">Updated</span>'
                          : b.state === 'failed' ? '<span class="badge text-bg-danger">Failed</span>'
                          : '<span class="badge text-bg-warning">Waiting</span>';
                return '<tr>' +
                    '<td>' + ( b.box_name ? esc( b.box_name ) : '<span class="text-body-secondary">No name</span>' ) + '</td>' +
                    '<td class="cms-mono">' + esc( b.mac ) + '</td>' +
                    '<td class="cms-mono">' + esc( b.ip ) + '</td>' +
                    '<td>' + ( b.installed ? esc( b.installed ) : '<span class="text-body-secondary">not installed</span>' ) + '</td>' +
                    '<td>' + badge + ( b.message ? '<div class="small text-danger">' + esc( b.message ) + '</div>' : '' ) + '</td>' +
                    '<td class="text-end">' + ( b.state !== 'up_to_date'
                        ? '<button class="btn btn-sm btn-outline-secondary cms-apk-adb" data-id="' + p.id + '" data-mac="' + esc( b.mac ) + '"><span class="spinner-border spinner-border-sm me-1 d-none"></span>Install via ADB</button>' : '' ) + '</td>' +
                '</tr>';
            }).join( '' );
            var cid = 'apk_boxes_' + p.id;
            return '<div class="card mb-3">' +
                '<div class="card-body">' +
                    '<div class="d-flex flex-wrap align-items-center justify-content-between gap-3">' +
                        '<div>' +
                            '<div class="fw-semibold">' + esc( p.label || p.package ) + ' <span class="badge text-bg-light border">' + kind + '</span>' +
                                ( p.offered ? ' <span class="badge text-bg-primary">Offered to boxes</span>' : '' ) + '</div>' +
                            '<div class="small text-body-secondary"><span class="cms-mono">' + esc( p.package ) + '</span> · version ' + esc( p.version_name || '-' ) + ' (' + p.version_code + ') · ' + Cms.size( p.size ) +
                                ' · uploaded ' + esc( Cms.time( p.uploaded_on ) ) + ' by ' + esc( p.uploaded_by ) + '</div>' +
                        '</div>' +
                        '<div class="d-flex align-items-center gap-3">' +
                            '<div class="form-check form-switch mb-0" title="Active APKs are offered to the boxes (the newest per app)">' +
                                '<input class="form-check-input cms-apk-active" type="checkbox" role="switch" id="apk_active_' + p.id + '" data-id="' + p.id + '"' + ( p.active ? ' checked' : '' ) + '>' +
                                '<label class="form-check-label small" for="apk_active_' + p.id + '">Active</label>' +
                            '</div>' +
                            '<button class="btn btn-sm btn-outline-danger cms-apk-delete" data-id="' + p.id + '" title="Delete"><i class="bi bi-trash"></i></button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="d-flex align-items-center gap-3 mt-3">' +
                        '<div class="progress flex-grow-1" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar bg-success" style="width:' + pct + '%"></div></div>' +
                        '<div class="small text-nowrap">' + p.done + ' / ' + total + ' boxes' + ( p.failed ? ' · <span class="text-danger">' + p.failed + ' failed</span>' : '' ) + '</div>' +
                        '<button class="btn btn-sm btn-link text-nowrap" data-bs-toggle="collapse" data-bs-target="#' + cid + '">Boxes <i class="bi bi-chevron-down"></i></button>' +
                    '</div>' +
                    '<div class="collapse' + ( open.indexOf( cid ) >= 0 ? ' show' : '' ) + '" id="' + cid + '">' +
                        '<div class="table-responsive cms-apk-boxes mt-3"><table class="table table-sm align-middle mb-0 cms-table">' +
                            '<thead><tr><th>Box name</th><th>MAC</th><th>IP</th><th>Installed</th><th>State</th><th></th></tr></thead>' +
                            '<tbody>' + ( rows || '<tr><td colspan="6" class="text-center text-body-secondary py-3">No boxes yet.</td></tr>' ) + '</tbody>' +
                        '</table></div>' +
                    '</div>' +
                '</div>' +
            '</div>';
        }).join( '' ) );
    },

    /**
     * @description Uploads the chosen APK
     * @param {jQuery} $b - Upload button
     * @returns {void}
     */
    uploadApk: function( $b ){
        var file = $( '#input_apk' )[ 0 ].files[ 0 ];
        if( !file ){
            Cms.toast( 'Choose an APK file first', 'warning' );
            return;
        }
        var fd = new FormData();
        fd.append( 'file', file );
        Cms.busy( $b, true );
        Cms.api( 'POST', 'apks', fd ).done( function( a ){
            Cms.toast( a.apk.package + ' ' + a.apk.version_name + ' uploaded. Boxes install it at their next check-in.', 'success' );
            $( '#input_apk' ).val( '' );
            Cms.loadApks();
        }).fail( Cms.toastError ).always( function(){ Cms.busy( $b, false ); } );
    },

    // ==================== Settings ====================

    /**
     * @description Loads the settings page
     * @returns {void}
     */
    loadSettings: function(){
        Cms.api( 'GET', 'settings' ).done( function( s ){
            $( '#set_property' ).text( s.property_name );
            $( '#set_property_id' ).text( s.property_id );
            $( '#set_address' ).text( ( s.lan_ip || '?' ) + ' : ' + s.port );
            $( '#set_version' ).text( s.version );
            $( '#input_adb_path' ).val( s.adb_path );
            $( '#set_adb_version' ).text( s.adb_version );
        }).fail( Cms.toastError );
    },

    // ==================== Helpers ====================

    /**
     * @description Shows / hides a button's spinner and disables it meanwhile
     * @param {jQuery} $b - Button with a .spinner-border inside
     * @param {boolean} on - Busy
     * @returns {void}
     */
    busy: function( $b, on ){
        $b.prop( 'disabled', on ).find( '.spinner-border' ).toggleClass( 'd-none', !on );
    },

    /**
     * @description Confirmation dialog
     * @param {string} title - Dialog title
     * @param {string} text - Question
     * @param {function} onOk - Called on OK
     * @returns {void}
     */
    confirm: function( title, text, onOk ){
        var modal = bootstrap.Modal.getOrCreateInstance( '#modal_confirm' );
        $( '#confirm_title' ).text( title );
        $( '#confirm_text' ).text( text );
        $( '#confirm_ok' ).off( 'click' ).on( 'click', function(){ modal.hide(); onOk(); } );
        modal.show();
    },

    /**
     * @description Small message at the bottom right
     * @param {string} text - Message
     * @param {string} [type='primary'] - success / warning / danger / primary
     * @returns {void}
     */
    toast: function( text, type ){
        var $t = $( '<div class="toast align-items-center border-0 text-bg-' + ( type || 'primary' ) + '" role="alert" aria-live="assertive" aria-atomic="true">' +
                    '<div class="d-flex"><div class="toast-body"></div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div></div>' );
        $t.find( '.toast-body' ).text( text );
        $( '#toasts' ).append( $t );
        $t.on( 'hidden.bs.toast', function(){ $t.remove(); } );
        new bootstrap.Toast( $t[ 0 ], { delay: type === 'danger' ? 8000 : 4000 } ).show();
    },

    /**
     * @description Error toast (for .fail handlers)
     * @param {string} text - Error
     * @returns {void}
     */
    toastError: function( text ){
        Cms.toast( text, 'danger' );
    },

    /**
     * @description Epoch ms as local date and time
     * @param {number} ms - Epoch ms
     * @returns {string}
     */
    time: function( ms ){
        return ms ? new Date( ms ).toLocaleString( undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } ) : '-';
    },

    /**
     * @description "3 min ago" style age
     * @param {number} ms - Epoch ms
     * @returns {string}
     */
    ago: function( ms ){
        var s = Math.max( 0, Math.round( ( Cms.boxMeta.now - ms ) / 1000 ) );
        if( s < 60 ){ return 'just now'; }
        if( s < 3600 ){ return Math.floor( s / 60 ) + ' min ago'; }
        if( s < 86400 ){ return Math.floor( s / 3600 ) + ' h ago'; }
        return Math.floor( s / 86400 ) + ' d ago';
    },

    /**
     * @description Bytes as KB / MB
     * @param {number} n - Bytes
     * @returns {string}
     */
    size: function( n ){
        return n >= 1048576 ? ( n / 1048576 ).toFixed( 1 ) + ' MB' : Math.max( 1, Math.round( n / 1024 ) ) + ' KB';
    },

    /**
     * @description Text made safe for HTML
     * @param {*} text - Any value
     * @returns {string}
     */
    escape: function( text ){
        return $( '<div>' ).text( text === null || text === undefined ? '' : String( text ) ).html().replace( /"/g, '&quot;' );
    }
};

$( function(){
    Cms.init();
});
