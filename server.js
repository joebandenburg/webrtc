var express = require("express");
var WebSocketServer = require("ws").Server;

var app = express();
app.use("/", express.static(__dirname + "/public"));

var server = app.listen(8080);

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
