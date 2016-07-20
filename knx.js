/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

var eibd = require('eibd');
var parseString = require('xml2js').parseString;


var eibdConnection;
var utils =    require(__dirname + '/lib/utils'); // Get common adapter utils
// you have to require the adapter module and pass a options object
var mapping = {};

var adapter = utils.adapter({
    // name has to be set and has to be equal to adapters folder name and main file name excluding extension
    name:           'knx',

    // is called if a subscribed object changes
    objectChange: function (id, obj) {

    },
    // is called if a subscribed state changes
    stateChange: function (id, state) {
        adapter.log.info('stateChange ' + id + ' ' + JSON.stringify(state));

        // you can use the ack flag to detect if state is desired or acknowledged
        if (!state.ack)
        {
            var ga = id.split('.')[2];
            adapter.log.info('setting state '+ga+' to '+state.val);
            var gad=eibd.str2addr(ga);
            adapter.log.info('Gad : ' + gad);
     //       / * Todo: Guess DPT */
            var tempCon=eibd.Connection();
            tempCon.socketRemote({ host: adapter.config.gwip, port: adapter.config.gwipport },function(x){
                tempCon.openTGroup(gad,1,function(err){
                    var data=new Array(2);
                    data[0]=0;
                    data[1]=0x80 | state.val;
                    tempCon.sendAPDU(data,function(){
                        tempCon.end();
                    });
                });
            });
        }

    },

    // is called when adapter shuts down - callback has to be called under any circumstances!
    unload: function (callback) {
        try {
            if (eibdConnection) {
                /* Workaround against Parser not implementing end() - https://github.com/andreek/node-eibd/issues/7 */
                if (eibdConnection.parser) eibdConnection.parser.end = function(){ /* Dummy */ };
                eibdConnection.end();
            }
            // adapter.log.info('cleaned everything up...');
        } finally {
            callback();
        }
    },

    // is called when databases are connected and adapter received configuration.
    // start here!
    ready: function () {
        adapter.subscribeStates('*');
        main();
    }

});

function parseXml(text, callback) {
    parseString(text, function(err, result){
        //Extract the value from the data element
        callback(err, result ? result['GroupAddress-Export'] : null);
    });
}

function main() {
    // The adapters config (in the instance object everything under the attribute "native") is accessible via
    // adapter.config:
    adapter.log.info('Connecting to eibd ' + adapter.config.gwip + ":" +adapter.config.gwipport);

    var gaTable = adapter.config.gaTable;

    adapter.log.info(utils.controllerDir);

    function parseGARange(gaRange, path) {
        if (!gaRange) return adapter.log.error('Unknown XML format. No GroupRange found');

        path = path || '';

        // Main groups
        for (var ix = 0; ix < gaRange.length; ix++) {
            var gar = gaRange[ix];
            if (gar.GroupRange) {
                var locpath = path;
                if (gar.$ && gar.$.Name) {
                    locpath += (path ? '.' : '') + gaRange[ix].$.Name.replace(/\./g, '_').replace(/\s/g, '_');
                }
                parseGARange(gaRange[ix].GroupRange, locpath);
            } else if (gar.GroupAddress) {
                var locpath = path;
                if (gar.$ && gar.$.Name) {
                    locpath += (path ? '.' : '') + gar.$.Name.replace(/\./g, '_').replace(/\s/g, '_');
                }
                for (var gaIX = 0; gaIX < gar.GroupAddress.length; gaIX++) {
                    var ga = gar.GroupAddress[gaIX].$;
                    //adapter.log.info('ga : ' + ga);
                    // Heavy magic - enrich object if there, create otherwise
                    var obj = {_id: (locpath ? locpath + '.' : '') + ga.Address.replace(/\//g, '_'), type: 'state', common: {name: ga.Name}, native: {address: ga.Address}};
                    //adapter.log.info('obj : ' + obj);
                    //obj.getElementsByName("Address")
                    adapter.extendObject(obj._id, obj);
                    mapping[ga.Address] = obj;
                }
            }
        }
    }


   // function parseGARange(gaRange) {
   //     adapter.log.info('gaRange : ' + gaRange);
   // }

    /*parseString(adapter.config.gaTable, function (err, result) {
        adapter.log.info('parseString : ' + result["GroupAddress-Export"]);
        parseGARange(result["GroupAddress-Export"].GroupRange);
        //adapter.log.info("GroupAddress-Export : " + result["GroupAddress-Export"].GroupRange);
    });*/


   // Establish the eibd connection
    function groupsocketlisten(opts, callback) {
        eibdConnection = eibd.Connection();
        eibdConnection.socketRemote(opts, function() {
            eibdConnection.openGroupSocket(0, callback);
        });
    }

    parseXml(adapter.config.gaTable, function (error, result) {
        if (result) {
            parseGARange(result.GroupRange);
        }

        // and setup the message parser
        groupsocketlisten({host: adapter.config.gwip, port: adapter.config.gwipport}, function (parser) {
            parser.decoder.decode = function (len, data, callback) {

                var err = null;
                var type = 'DPT1';
                var value = null;

                // eis 1 / dpt 1.xxx
                if(len === 8) {
                    value = data-64;
                    if(value > 1) {
                        value = value-64;
                    }
                }

                // eis 6 / dpt 5.xxx
                // assumption
                if(len === 9){
                    type = 'DPT5';
                    if(data.length === 1) {
                        value = this.decodeDPT5(data);
                    } else {
                        err = new Error('Invalid data len for DPT5');
                    }
                }

                // eis 5 / dpt 9.xxx
                // assumption
                if(len === 10) {
                    type = 'DPT9';
                    if(data.length === 2) {
                        value = this.decodeDPT9(data);
                    }
                    else {
                        err = new Error('Invalid data len for DPT9');
                    }
                }
                if (len === 12) {
                    type = 'DPT12';
                    // float
                    if(data.length === 4) {
                        value = this.decodeDPT12(data);
                    }
                    else {
                        err = new Error('Invalid data len for DPT9');
                    }
                }

                if(callback) {
                    callback(err, type, value);
                }
            };
            parser.on('write', function(src, dest, dpt, val){
                if (mapping[dest]) dest = mapping[dest].common.name;
                /* Message received to a GA */
                adapter.log.info('Write from ' + src + ' to ' + dest + ': ' + val + ' (' + dpt + ')');
                adapter.setState(dest,{val: val, ack: true, from: src});
            });

            parser.on('response', function(src, dest, val) {
                if (mapping[dest]) dest = mapping[dest].common.name;
                adapter.log.info('Response from ' + src + ' to ' + dest + ': '+val);
            });

            parser.on('read', function(src, dest) {
                if (mapping[dest]) dest = mapping[dest].common.name;
                adapter.log.info('Read from ' + src + ' to ' + dest);
            });

        });
    });
}
