# node-red-contrib-zenitel-wamp-auth
This collection implements a WAMP interface using token authentication. It is based on the node-red-contrib-wamp-auth module.

A <a href="http://nodered.org" target="_new">Node-RED</a> node to wrap wamp client (with authentication) as one of these roles (publisher, subscriber, caller and callee).
Forked from <a href="https://www.npmjs.com/package/node-red-contrib-wamp" target="_new">node-red-contrib-wamp</a>.

Install
-------

Run the following command in your Node-RED user directory

    npm install node-red-contrib-zenitel-wamp-auth-test


Usage
-----
Connects to a WAMP router to publish and subscribe messages according to one topic or call remote WAMP client or register a callee for remote client to call it.
