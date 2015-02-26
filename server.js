var constants = require("constants");
var fs = require("fs");
var https = require("https");
var express = require("express");
var WebSocketServer = require("ws").Server;

var app = express();
app.use(function(req, res, next) {
    res.header("Strict-Transport-Security", "max-age=864000; preload");
    next();
});
app.use("/", express.static(__dirname + "/public"));

var privateKey = fs.readFileSync("tls/privateKey.pem");
var certificate = fs.readFileSync("tls/certificate.pem");
var ca = fs.readFileSync("tls/ca.pem");
var dhparams = fs.readFileSync("tls/dhparams.pem");

var server = https.createServer({
    key: privateKey,
    cert: certificate,
    ca: ca,
    secureProtocol: "SSLv23_method",
    secureOptions: constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_SSLv2,
    honorCipherOrder: true,
    // from https://wiki.mozilla.org/Security/Server_Side_TLS
    ciphers: "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:DHE-DSS-AES128-GCM-SHA256:kEDH+AESGCM:ECDHE-RSA-AES128-SHA256:ECDHE-ECDSA-AES128-SHA256:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES256-SHA384:ECDHE-ECDSA-AES256-SHA384:ECDHE-RSA-AES256-SHA:ECDHE-ECDSA-AES256-SHA:DHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA:DHE-DSS-AES128-SHA256:DHE-RSA-AES256-SHA256:DHE-DSS-AES256-SHA:DHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA256:AES256-SHA256:AES128-SHA:AES256-SHA:AES:CAMELLIA:DES-CBC3-SHA:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!aECDH:!EDH-DSS-DES-CBC3-SHA:!EDH-RSA-DES-CBC3-SHA:!KRB5-DES-CBC3-SHA",
    ecdhCurve: "secp384r1",
    dhparam: dhparams
}, app).listen(443);

var wss = new WebSocketServer({
    server: server,
    path: "/websocket"
});

var ids = 1;
var connections = {};

var broadcast = function(fromId, message) {
    Object.keys(connections).forEach(function(id) {
        if (id != fromId) {
            connections[id].send(message);
        }
    });
};

wss.on("connection", function(ws) {
    ws.id = ids++;
    console.log("connection", ws.id);
    connections[ws.id] = ws;
    ws.on("message", function(data) {
        var message = JSON.parse(data);
        console.log("message", ws.id, message);
        message.id = ws.id;
        if (message.to) {
            var otherWs = connections[message.to];
            if (otherWs) {
                otherWs.send(JSON.stringify(message));
            }
        } else {
            broadcast(ws.id, JSON.stringify(message));
        }
    });
    ws.on("close", function() {
        broadcast(ws.id, JSON.stringify({
            type: "leave",
            id: ws.id
        }));
        delete connections[ws.id];
    });
});
