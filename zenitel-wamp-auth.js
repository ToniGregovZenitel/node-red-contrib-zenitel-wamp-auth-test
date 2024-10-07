module.exports = function (RED) {
    "use strict";
    var events = require("events");
    var autobahn = require("autobahn");
    var settings = RED.settings;
    var cryptojs = require("crypto-js");

//Must be active when running from Linux
//	var fetch = require("node-fetch");
	
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

	const tls = require("tls");

	tls.DEFAULT_MIN_VERSION = "TLSv1.2";
	tls.DEFAULT_MAX_VERSION = "TLSv1.3";

  function WampClientNode(config) {
    RED.nodes.createNode(this, config);
    
    this.address = config.address;
    this.realm = config.realm;
    this.authId = config.authId;
    this.password = config.password;

    // Get or create a WAMP client instance
    this.wampClient = function () {
        try {
            return wampClientPool.get(this.address, this.realm, this.authId, this.password);
        } catch (error) {
            this.error(`Error getting WAMP client: ${error.message}`);
            this.status({ fill: "red", shape: "ring", text: "connection error" });
            return null;
        }
    };

    // Bind event listeners
    this.on = function (a, b) {
        try {
            const client = this.wampClient();
            if (client) {
                client.on(a, b);
            } else {
                this.error("No WAMP client available to bind events.");
            }
        } catch (error) {
            this.error(`Error binding event listener: ${error.message}`);
        }
    };

    // Close the connection
    this.close = function (done) {
        try {
            wampClientPool.close(this.address, this.realm, done);
        } catch (error) {
            this.error(`Error closing WAMP client: ${error.message}`);
            done(error);
        }
    };
}

RED.nodes.registerType("wamp-client", WampClientNode);


    function WampClientOutNode(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.role = config.role;
        this.topic = config.topic;
        this.clientNode = RED.nodes.getNode(this.router);

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg) {
                if (msg.hasOwnProperty("payload")) {
                    var payload = msg.payload;
                    switch (this.role) {
                        case "publisher":
                            RED.log.info("wamp client publish: topic=" + this.topic + ", payload=" + JSON.stringify(payload));
                            payload && node.wampClient.publish(this.topic, payload);
                            break;
                        case "calleeResponse":
                            RED.log.info("wamp client callee response=" + JSON.stringify(payload));
                            msg._d && msg._d.resolve(payload);
                            break;
                        default:
                            RED.log.error("the role ["+this.role+"] is not recognized.");
                            break;
                    }
                }
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("wamp out", WampClientOutNode);

    function WampClientInNode(config) {
        RED.nodes.createNode(this, config);
        this.role = config.role;
        this.router = config.router;
        this.topic = config.topic;

        this.clientNode = RED.nodes.getNode(this.router);

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            switch (this.role) {
                case "subscriber":
                    node.wampClient.subscribe(this.topic, function (args, kwargs) {
                        var msg = {topic: this.topic,  payload: {args: args, kwargs: kwargs}};
                        node.send(msg);
                    });
                    break;
                case "calleeReceiver":
                    node.wampClient.registerProcedure(this.topic, function (args, kwargs) {
                        RED.log.debug("procedure: " + args +", " +kwargs);
                        var d = autobahn.when.defer(); // create a deferred
                        var msg = {procedure: this.topic, payload: {args: args, kwargs: kwargs}, _d: d};
                        node.send(msg);
                        return d.promise;
                    });
                    break;
                default:
                    RED.log.error("the role ["+this.role+"] is not recognized.");
                    break;
            }
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("wamp in", WampClientInNode);


    function WampClientCallNode(config) {
        RED.nodes.createNode(this, config);
        this.router = config.router;
        this.procedure = config.procedure;

        this.clientNode = RED.nodes.getNode(this.router)

        if (this.clientNode) {
            var node = this;
            node.wampClient = this.clientNode.wampClient();

            this.clientNode.on("ready", function () {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.clientNode.on("closed", function () {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });

            node.on("input", function (msg) {
                if (this.procedure) {
                    var d = node.wampClient.callProcedure(this.procedure, msg.payload);
                    if (d) {
                        d.then(
                            function (resp) {
                                RED.log.debug("call result: " +JSON.stringify(resp));
                                node.send({payload: resp});
                            },
                            function (err) {
                                RED.log.warn("call response failed: " + err.error);
                            }
                        )
                    }
                }
            });
        } else {
            RED.log.error("wamp client config is missing!");
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                this.clientNode.close(done);
            } else {
                done();
            }
        });
    }
    RED.nodes.registerType("wamp call", WampClientCallNode);
	
	
	async function GetToken(id, passw, address)
	{
		RED.log.info("GetToken.");

		var _token = "";
		var encoded = btoa(id + ":" + passw);
		
//EM		RED.log.info("WampClientPool: authid: " + id + ". password: " + passw + ". url: " + address);
		
		var addr = address.replace(" ", "");
		var encrypt  = addr.includes("wss");
		const addrPortArray = addr.split(':');
		var ipAddr = "168.254.1.5";
		ipAddr = addrPortArray[1].substring(2);
		var _url = "";

//EM		RED.log.info("WampClientPool: addrPortArray: " + addrPortArray);
//EM		RED.log.info("WampClientPool: IP-addr: " + ipAddr + ". Encrypted: " + encrypt.toString());
		
		if (encrypt)
		{
			_url = "https://" + ipAddr + ":443/api/auth/login";
		}
		else
		{
			_url = "http://" + ipAddr + ":80/api/auth/login";
		}
		
		RED.log.info("WampClientPool: url: " + _url);
			
		let response = await fetch(_url,
										{
										  method: "POST",
										  headers:
										  {
											"ContentType" : "application/json",
											"Accept" : "application/json",
											"Timeout" : 5000,										
											"Authorization" : "Basic " + encoded,
										  },
										});
		let json_object = await response.json();

		if (response.ok)
		{
			var json_text = JSON.stringify(json_object);	
			_token = json_object["access_token"];
			
			RED.log.info("Token Received OK.");
		}
		else
		{
				RED.log.info("GetToken fails.");
		}
		return _token;	
	}




    var wampClientPool = (function ()
	{
        var connections = {};
        return {
            get: function (address, realm, authid, password) {
                var uri = realm + "@" + address;

                if (!connections[uri])
				{
                    connections[uri] = (function ()
					{
                        var obj = {
                            _emitter: new events.EventEmitter(),
                            wampConnection: null,
                            wampSession: null,
                            _connecting: false,
                            _connected: false,
                            _closing: false,
                            _subscribeReqMap: {},
                            _subscribeMap: {},
                            _procedureReqMap: {},
                            _procedureMap: {},
                            on: function (a, b) {
                                this._emitter.on(a, b);
                            },
                            close: function () {
                                _disconnect();
                            },
                            publish: function (topic, message) {
                                if (this.wampSession) {
                                    RED.log.debug("wamp publish: topic=" + topic + ", message=" + JSON.stringify(message));
                                    if (message instanceof Object) {
                                        this.wampSession.publish(topic, null, message);
                                    } else if (Array.isArray(message)) {
                                        this.wampSession.publish(topic, message);
                                    } else {
                                        this.wampSession.publish(topic, [message]);
                                    }
                                } else {
                                    RED.log.warn("publish failed, wamp is not connected.");
                                }
                            },
                            subscribe: function (topic, handler) {
                                RED.log.debug("add to wamp subscribe request for topic: " + topic);
                                this._subscribeReqMap[topic] = handler;

                                if (this._connected && this.wampSession) {
                                    this._subscribeMap[topic] = this.wampSession.subscribe(topic, handler);
                                }
                            },
                            // unsubscribe: function (topic) {
                                // if (this._subscribeReqMap[topic]) {
                                //     delete this._subscribeReqMap[topic];
                                // }
                                //
                                // if (this._subscribeMap[topic]) {
                                //     if (this.wampSession) {
                                //         this.wampSession.unsubscribe(this._subscribeMap[topic]);
                                //         RED.log.info("unsubscribed wamp topic: ", topic);
                                //     }
                                //     delete this._subscribeMap[topic];
                                // }
                            // },
                            registerProcedure: function (procedure, handler) {
                                RED.log.debug("add to wamp request for procedure: " + procedure);
                                this._procedureReqMap[procedure] = handler;

                                if (this._connected && this.wampSession) {
                                    this._procedureMap[procedure] = this.wampSession.subscribe(procedure, handler);
                                }
                            },
                            callProcedure: function (procedure, message) {
                                if (this.wampSession)
								{
                                    RED.log.debug("wamp call: procedure=" + procedure + ", message=" + JSON.stringify(message));
									
									
									
                                    var d = null;
                                    if (message instanceof Object) {
                                        d = this.wampSession.call(procedure, null, message);
                                    } else if (Array.isArray(message)) {
                                        d = this.wampSession.call(procedure, message);
                                    } else {
                                        d = this.wampSession.call(procedure, [message]);
                                    }

                                    return d;
                                } else {
                                    RED.log.warn("call failed, wamp is not connected.");
                                }
                            }
                        };

                        var _disconnect = function() {
                            if (obj.wampConnection) {
                                obj.wampConnection.close();
                            }
                        };

                        var setupWampClient = function () {
                            obj._connecting = true;
                            obj._connected = false;
                            obj._emitter.emit("closed");
													
//EM							RED.log.info("WampClientPool: authid: " + authid + ". password: " + password + ". url: " + address);
							
							var encrypt  = address.includes("wss");
							
							if (encrypt)
							{
							
								var options = {
									url: address,
									realm: realm,
									retry_if_unreachable: true,
									max_retries: -1,
									authmethods: ['ticket'],
									authid: authid,
									key: "", //fs.readFileSync('ZenitelConnectPrivateKey.key', 'utf8'),
									cert: "", //fs.readFileSync('ZenitelConnectServerCertificate.crt', 'utf8'),
									ca:   "", //fs.readFileSync('ZenitelConnectServerCertificate.crt', 'utf8'),
									rejectUnauthorized: false,
									onchallenge: function ()
									{																
										var token = GetToken(authid, password, address);
										return token;
									}
								};
							}
							else
							{
								var options = {
									url: address,
									realm: realm,
									retry_if_unreachable: true,
									max_retries: -1,
									authmethods: ['ticket'],
									authid: authid,
									onchallenge: function ()
									{																
										var token = GetToken(authid, password, address);
										return token;
									}
								};

							}

                            obj.wampConnection = new autobahn.Connection(options);

                            obj.wampConnection.onopen = function (session) {

//                                RED.log.info("wamp client [" + JSON.stringify(options) + "] connected.");

                                obj.wampSession = session;
                                obj._connected = true;
                                obj._emitter.emit("ready");

                                obj._subscribeMap = {};
                                for (var topic in obj._subscribeReqMap) {
                                    obj.wampSession.subscribe(topic, obj._subscribeReqMap[topic]).then(
                                        function (subscription) {
                                            obj._subscribeMap[topic] = subscription;
                                            RED.log.debug("wamp subscribe topic [" +topic + "] success.");
                                        },
                                        function (err) {
                                            RED.log.warn("wamp subscribe topic ["+topic+"] failed: " + err);
                                        }
                                    )
                                }

                                obj._procedureMap = {};
                                for (var procedure in obj._procedureReqMap) {
                                    obj.wampSession.register(procedure, obj._procedureReqMap[procedure]).then(
                                        function (registration) {
                                            obj._procedureMap[procedure] = registration;
                                            RED.log.debug("wamp register procedure [" + procedure + "] success.");
                                        },
                                        function (err) {
                                            RED.log.warn("wamp register procedure ["+procedure+"] failed: " + err.error);
                                        }
                                    )
                                }

                                obj._connecting = false;
                            };

                            obj.wampConnection.onclose = function (reason, details) {
                                obj._connecting = false;
                                obj._connected = false;
                                if (!obj._closing) {
                                    // RED.log.error("unexpected close", {uri:uri});
                                    obj._emitter.emit("closed");
                                }
                                obj._subscribeMap = {};
                                RED.log.info("wamp client closed");
                            };

                            obj.wampConnection.open();
                        };

                        setupWampClient();
                        return obj;
                    }());
                }
                return connections[uri];
            },
            close: function (address, realm, done) {
                var uri = realm + "@" + address;
                if (connections[uri]) {
                    RED.log.info("ready to close wamp client [" + uri +"]");
                    connections[uri]._closing = true;
                    connections[uri].close();
                    (typeof(done) == 'function') && done();
                    delete connections[uri];
                } else {
                    (typeof(done) == 'function') && done();
                }
            }
        }
    }());
}
