module.exports = function(RED) {
    "use strict";
    var events = require("events");
    var autobahn = require("autobahn");
    var settings = RED.settings;
    var cryptojs = require("crypto-js");

    //Must be active when running from Linux
    //	var fetch = require("node-fetch");

    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

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
        this.wampClient = function() {
            try {
                return wampClientPool.get(this.address, this.realm, this.authId, this.password);
            } catch (error) {
                this.error(`Error getting WAMP client: ${error.message}`);
                this.status({
                    fill: "red",
                    shape: "ring",
                    text: "connection error"
                });
                return null;
            }
        };

        // Bind event listeners
        this.on = function(a, b) {
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
        this.close = function(done) {
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
            try {
                node.wampClient = this.clientNode.wampClient();
            } catch (error) {
                this.error(`Error initializing WAMP client: ${error.message}`);
                this.status({
                    fill: "red",
                    shape: "ring",
                    text: "connection error"
                });
                return;
            }

            this.clientNode.on("ready", function() {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "node-red:common.status.connected"
                });
            });
            this.clientNode.on("closed", function() {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "node-red:common.status.not-connected"
                });
            });

            node.on("input", function(msg) {
                if (msg.hasOwnProperty("payload")) {
                    var payload = msg.payload;
                    try {
                        switch (this.role) {
                            case "publisher":
                                RED.log.info("wamp client publish: topic=" + this.topic + ", payload=" + JSON.stringify(payload));
                                if (payload) {
                                    node.wampClient.publish(this.topic, payload);
                                } else {
                                    this.error("Empty payload for publish");
                                }
                                break;
                            case "calleeResponse":
                                RED.log.info("wamp client callee response=" + JSON.stringify(payload));
                                if (msg._d) {
                                    msg._d.resolve(payload);
                                } else {
                                    this.error("Missing deferred response object (_d) for calleeResponse");
                                }
                                break;
                            default:
                                RED.log.error("The role [" + this.role + "] is not recognized.");
                                break;
                        }
                    } catch (error) {
                        this.error(`Error during message handling for role [${this.role}]: ${error.message}`);
                    }
                }
            });
        } else {
            RED.log.error("WAMP client config is missing!");
            this.status({
                fill: "red",
                shape: "ring",
                text: "config missing"
            });
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                try {
                    this.clientNode.close(done);
                } catch (error) {
                    this.error(`Error closing WAMP client: ${error.message}`);
                    done(error);
                }
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
            try {
                node.wampClient = this.clientNode.wampClient();
            } catch (error) {
                this.error(`Error initializing WAMP client: ${error.message}`);
                this.status({
                    fill: "red",
                    shape: "ring",
                    text: "connection error"
                });
                return;
            }

            this.clientNode.on("ready", function() {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "node-red:common.status.connected"
                });
            });

            this.clientNode.on("closed", function() {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "node-red:common.status.not-connected"
                });
            });

            try {
                switch (this.role) {
                    case "subscriber":
                        node.wampClient.subscribe(this.topic, function(args, kwargs) {
                            try {
                                var msg = {
                                    topic: node.topic,
                                    payload: {
                                        args: args,
                                        kwargs: kwargs
                                    }
                                };
                                node.send(msg);
                            } catch (error) {
                                node.error(`Error handling subscription message: ${error.message}`);
                            }
                        });
                        break;

                    case "calleeReceiver":
                        node.wampClient.registerProcedure(this.topic, function(args, kwargs) {
                            try {
                                RED.log.debug("Procedure called: " + args + ", " + kwargs);
                                var d = autobahn.when.defer(); // create a deferred
                                var msg = {
                                    procedure: node.topic,
                                    payload: {
                                        args: args,
                                        kwargs: kwargs
                                    },
                                    _d: d
                                };
                                node.send(msg);
                                return d.promise;
                            } catch (error) {
                                node.error(`Error handling procedure call: ${error.message}`);
                            }
                        });
                        break;

                    default:
                        RED.log.error("The role [" + this.role + "] is not recognized.");
                        break;
                }
            } catch (error) {
                this.error(`Error setting up WAMP client for role [${this.role}]: ${error.message}`);
            }
        } else {
            RED.log.error("WAMP client config is missing!");
            this.status({
                fill: "red",
                shape: "ring",
                text: "config missing"
            });
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                try {
                    this.clientNode.close(done);
                } catch (error) {
                    this.error(`Error closing WAMP client: ${error.message}`);
                    done(error);
                }
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

        this.clientNode = RED.nodes.getNode(this.router);

        if (this.clientNode) {
            var node = this;
            try {
                node.wampClient = this.clientNode.wampClient();
            } catch (error) {
                this.error(`Error initializing WAMP client: ${error.message}`);
                this.status({
                    fill: "red",
                    shape: "ring",
                    text: "connection error"
                });
                return;
            }

            this.clientNode.on("ready", function() {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "node-red:common.status.connected"
                });
            });

            this.clientNode.on("closed", function() {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "node-red:common.status.not-connected"
                });
            });

            node.on("input", function(msg) {
                if (this.procedure) {
                    try {
                        var d = node.wampClient.callProcedure(this.procedure, msg.payload);
                        if (d) {
                            d.then(
                                function(resp) {
                                    RED.log.debug("Call result: " + JSON.stringify(resp));
                                    node.send({
                                        payload: resp
                                    });
                                },
                                function(err) {
                                    RED.log.warn("Call response failed: " + err.error);
                                    node.error(`Procedure call failed: ${err.error}`, msg);
                                }
                            ).catch(function(error) {
                                node.error(`Promise rejection in procedure call: ${error.message}`, msg);
                            });
                        } else {
                            node.error("WAMP client returned an invalid deferred object.");
                        }
                    } catch (error) {
                        node.error(`Error during procedure call: ${error.message}`, msg);
                    }
                } else {
                    node.error("Procedure is not defined.");
                }
            });
        } else {
            RED.log.error("WAMP client config is missing!");
            this.status({
                fill: "red",
                shape: "ring",
                text: "config missing"
            });
        }

        this.on("close", function(done) {
            if (this.clientNode) {
                try {
                    this.clientNode.close(done);
                } catch (error) {
                    this.error(`Error closing WAMP client: ${error.message}`);
                    done(error);
                }
            } else {
                done();
            }
        });
    }

    RED.nodes.registerType("wamp call", WampClientCallNode);



    async function GetToken(id, passw, address) {
        RED.log.info("GetToken.");

        var _token = "";
        var encoded = btoa(id + ":" + passw);

        var addr = address.replace(" ", "");
        var encrypt = addr.includes("wss");
        const addrPortArray = addr.split(':');
        var ipAddr = "168.254.1.5";
        ipAddr = addrPortArray[1].substring(2);
        var _url = "";

        if (encrypt) {
            _url = "https://" + ipAddr + ":443/api/auth/login";
        } else {
            _url = "http://" + ipAddr + ":80/api/auth/login";
        }

        RED.log.info("WampClientPool: url: " + _url);

        try {
            let response = await fetch(_url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Authorization": "Basic " + encoded,
                },
                timeout: 5000 // Add timeout for better control
            });

            if (!response.ok) {
                RED.log.error(`GetToken failed: HTTP ${response.status} - ${response.statusText}`);
                return null;
            }

            let json_object = await response.json();
            _token = json_object["access_token"];
            RED.log.info("Token Received OK.");
        } catch (error) {
            RED.log.error(`Error in GetToken: ${error.message}`);
        }

        return _token;
    }




    var wampClientPool = (function() {
        var connections = {};
        return {
            get: function(address, realm, authid, password) {
                var uri = realm + "@" + address;

                if (!connections[uri]) {
                    connections[uri] = (function() {
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
                            on: function(a, b) {
                                this._emitter.on(a, b);
                            },
                            close: function() {
                                _disconnect();
                            },
                            publish: function(topic, message) {
                                try {
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
                                } catch (error) {
                                    RED.log.error("Failed to publish to topic [" + topic + "]: " + error.message);
                                }
                            },
                            subscribe: function(topic, handler) {
                                RED.log.debug("add to wamp subscribe request for topic: " + topic);
                                this._subscribeReqMap[topic] = handler;

                                if (this._connected && this.wampSession) {
                                    try {
                                        this._subscribeMap[topic] = this.wampSession.subscribe(topic, handler);
                                    } catch (error) {
                                        RED.log.error("Failed to subscribe to topic [" + topic + "]: " + error.message);
                                    }
                                }
                            },
                            registerProcedure: function(procedure, handler) {
                                RED.log.debug("add to wamp request for procedure: " + procedure);
                                this._procedureReqMap[procedure] = handler;

                                if (this._connected && this.wampSession) {
                                    try {
                                        this._procedureMap[procedure] = this.wampSession.register(procedure, handler);
                                    } catch (error) {
                                        RED.log.error("Failed to register procedure [" + procedure + "]: " + error.message);
                                    }
                                }
                            },
                            callProcedure: function(procedure, message) {
                                try {
                                    if (this.wampSession) {
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
                                } catch (error) {
                                    RED.log.error("Failed to call procedure [" + procedure + "]: " + error.message);
                                }
                            }
                        };

                        var _disconnect = function() {
                            try {
                                if (obj.wampConnection) {
                                    obj.wampConnection.close();
                                }
                            } catch (error) {
                                RED.log.error("Error during disconnect: " + error.message);
                            }
                        };

                        var setupWampClient = function() {
                            obj._connecting = true;
                            obj._connected = false;
                            obj._emitter.emit("closed");

                            var encrypt = address.includes("wss");

                            var options = {
                                url: address,
                                realm: realm,
                                retry_if_unreachable: true,
                                max_retries: -1,
                                authmethods: ['ticket'],
                                authid: authid,
                                rejectUnauthorized: false,
                                onchallenge: function() {
                                    try {
                                        var token = GetToken(authid, password, address);
                                        return token;
                                    } catch (error) {
                                        RED.log.error("Error during WAMP authentication challenge: " + error.message);
                                        return null;
                                    }
                                }
                            };

                            if (encrypt) {
                                options.key = ""; // Optional: Provide private key for encryption
                                options.cert = ""; // Optional: Provide certificate for encryption
                                options.ca = ""; // Optional: Provide CA certificate
                            }

                            try {
                                obj.wampConnection = new autobahn.Connection(options);

                                obj.wampConnection.onopen = function(session) {
                                    obj.wampSession = session;
                                    obj._connected = true;
                                    obj._emitter.emit("ready");

                                    for (var topic in obj._subscribeReqMap) {
                                        obj.wampSession.subscribe(topic, obj._subscribeReqMap[topic]).then(
                                            function(subscription) {
                                                obj._subscribeMap[topic] = subscription;
                                                RED.log.debug("wamp subscribe topic [" + topic + "] success.");
                                            },
                                            function(err) {
                                                RED.log.warn("wamp subscribe topic [" + topic + "] failed: " + err);
                                            }
                                        );
                                    }

                                    for (var procedure in obj._procedureReqMap) {
                                        obj.wampSession.register(procedure, obj._procedureReqMap[procedure]).then(
                                            function(registration) {
                                                obj._procedureMap[procedure] = registration;
                                                RED.log.debug("wamp register procedure [" + procedure + "] success.");
                                            },
                                            function(err) {
                                                RED.log.warn("wamp register procedure [" + procedure + "] failed: " + err.error);
                                            }
                                        );
                                    }

                                    obj._connecting = false;
                                };

                                obj.wampConnection.onclose = function(reason, details) {
                                    obj._connecting = false;
                                    obj._connected = false;
                                    if (!obj._closing) {
                                        obj._emitter.emit("closed");
                                    }
                                    obj._subscribeMap = {};
                                    RED.log.info("wamp client closed: " + reason);
                                };

                                obj.wampConnection.open();
                            } catch (error) {
                                RED.log.error("Failed to setup WAMP connection: " + error.message);
                            }
                        };

                        setupWampClient();
                        return obj;
                    }());
                }
                return connections[uri];
            },
            close: function(address, realm, done) {
                var uri = realm + "@" + address;
                if (connections[uri]) {
                    try {
                        RED.log.info("ready to close wamp client [" + uri + "]");
                        connections[uri]._closing = true;
                        connections[uri].close();
                        (typeof done === 'function') && done();
                        delete connections[uri];
                    } catch (error) {
                        RED.log.error("Error during WAMP client close: " + error.message);
                    }
                } else {
                    (typeof done === 'function') && done();
                }
            }
        };
    }());

};
