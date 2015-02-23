var localVideo = document.getElementById("localVideo");

navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;

var RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
var RTCIceCandidate = window.RTCIceCandidate || window.webkitRTCIceCandidate || window.mozRTCIceCandidate;
var RTCSessionDescription = window.RTCSessionDescription || window.mozRTCSessionDescription || window.webkitRTCSessionDescription;

var constraints = {
    audio: false,
    video: true
};

var pc_config = {
    iceServers: [{
//        url: "stun:stun.l.google.com:19302"
        url: "stun:stun.callwithus.com:3478"
    }]
};
var localStream;
var peers = {};
var ws = new WebSocket("ws://" + location.host + "/websocket");
ws.onopen = function() {
    navigator.getUserMedia(constraints, function(stream) {
        localStream = stream;
        localVideo.src = URL.createObjectURL(stream);
        ws.send(JSON.stringify({
            type: "join"
        }));
    }, handleError);
};
ws.onmessage = function(event) {
    var message = JSON.parse(event.data);
    console.log(message);
    switch (message.type) {
        case "join":
            peers[message.id] = createPeer(message.id);
            var peerConnection = peers[message.id].peerConnection;
            peerConnection.createOffer(function(sessionDescription) {
                peerConnection.setLocalDescription(sessionDescription, function() {
                    ws.send(JSON.stringify({
                        type: "offer",
                        to: message.id,
                        description: sessionDescription
                    }));
                }, handleError);
            }, handleError);
            break;
        case "leave":
            peers[message.id].video.remove();
            delete peers[message.id];
            break;
        case "offer":
            peers[message.id] = createPeer(message.id);
            var peerConnection = peers[message.id].peerConnection;
            peerConnection.setRemoteDescription(new RTCSessionDescription(message.description), function() {
                peerConnection.createAnswer(function(sessionDescription) {
                    peerConnection.setLocalDescription(new RTCSessionDescription(sessionDescription), function() {
                        ws.send(JSON.stringify({
                            type: "answer",
                            to: message.id,
                            description: sessionDescription
                        }));
                    }, handleError);
                }, handleError);
            }, handleError);
            break;
        case "answer":
            var peerConnection = peers[message.id].peerConnection;
            peerConnection.setRemoteDescription(new RTCSessionDescription(message.description), function() {}, handleError);
            break;
        case "candidate":
            var peerConnection = peers[message.id].peerConnection;
            var candidate = new RTCIceCandidate({
                sdpMLineIndex: message.label,
                sdpMid: message.sdpMid,
                candidate: message.candidate
            });
            peerConnection.addIceCandidate(candidate, function() {}, handleError);
            break;
    }
};

function createPeer(forId) {
    var peerConnection = new RTCPeerConnection(pc_config);
    peerConnection.addStream(localStream);
    peerConnection.onicecandidate = function(event) {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: "candidate",
                to: forId,
                label: event.candidate.sdpMLineIndex,
                sdpMid: event.candidate.sdpMid,
                candidate: event.candidate.candidate
            }));
        }
    };
    var video = document.createElement("video");
    video.setAttribute("autoplay", "");
    peerConnection.onaddstream = function(event) {
        document.querySelector("body").appendChild(video);
        video.src = URL.createObjectURL(event.stream);
        video.play();
    };
    peerConnection.onremovestream = function() {
        video.remove();
    };
    return {
        peerConnection: peerConnection,
        video: video
    };
}

function handleError(error) {
    console.log("Something went wrong", error);
}
