(function() {
    "use strict";

    navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;

    var RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
    var RTCIceCandidate = window.RTCIceCandidate || window.webkitRTCIceCandidate || window.mozRTCIceCandidate;
    var RTCSessionDescription = window.RTCSessionDescription || window.mozRTCSessionDescription || window.webkitRTCSessionDescription;

    var app = angular.module("WebRTC", []);
    var audioContext = new AudioContext();

    app.directive("webrtcContent", function() {
        return {
            restrict: "E",
            scope: {
                peer: "="
            },
            link: function(scope, element) {
                scope.$watch("peer.stream", function(stream) {
                    if (stream) {
                        if (stream.getVideoTracks().length > 0) {
                            var videoElement = element.find("video");
                            if (!videoElement.length) {
                                videoElement = angular.element(document.createElement("video"));
                                videoElement.attr("autoplay", "");
                                element.append(videoElement);
                            }
                            videoElement[0].src = URL.createObjectURL(stream);
                        } else if (!scope.peer.isSelf) {
                            var audioElement = element.find("audio");
                            if (!audioElement.length) {
                                audioElement = angular.element(document.createElement("audio"));
                                audioElement.attr("autoplay", "");
                                element.append(audioElement);
                            }
                            element.addClass("audio");
                            scope.peer.onDataChannelMessage = function(data) {
                                switch (data) {
                                    case "startTalking":
                                        element.addClass("active");
                                        break;
                                    case "stopTalking":
                                        element.removeClass("active");
                                        break;
                                }
                            };
                            audioElement[0].src = URL.createObjectURL(stream);
                        }
                    } else {
                        element.find("video").remove();
                        element.find("audio").remove();
                    }
                });
            }
        }
    });

    app.controller("ParticipantsController", function($scope, $interval) {
        var samples = 32;
        var threshold = 40;

        var constraints = {
            audio: true,
            video: false
        };

        var pc_config = {
            iceServers: [{
                url: "stun:stun.callwithus.com:3478"
            }]
        };

        var room = getRoom();
        var localStream;
        var peers = {};

        var wsProtocol = (location.protocol === "https:") ? "wss" : "ws";
        var ws = new WebSocket(wsProtocol + "://" + location.host + "/websocket?room=" + room);
        ws.onopen = function() {
            navigator.getUserMedia(constraints, function(stream) {
                localStream = stream;

                var source = audioContext.createMediaStreamSource(stream);
                var analyser = audioContext.createAnalyser();
                analyser.fftSize = samples;
                source.connect(analyser);

                var isTalking = false;
                var clear = _.debounce(function() {
                    $scope.$emit("stopTalking");
                    isTalking = false;
                }, 200);

                $interval(function() {
                    var data = new Uint8Array(samples);
                    analyser.getByteFrequencyData(data);
                    var avg = 0;
                    for (var i = 0; i < samples; i++) {
                        avg += data[i];
                    }
                    avg /= samples;
                    if (avg > threshold) {
                        if (!isTalking) {
                            isTalking = true;
                            $scope.$emit("startTalking");
                        }
                        clear();
                    }
                }, 10);

                $scope.$apply(function() {
                    $scope.self.stream = stream;
                });
                ws.send(JSON.stringify({
                    type: "join"
                }));
            }, handleError);
        };
        ws.onmessage = function(event) {
            $scope.$apply(function() {
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
            });
        };

        function createPeer(forId) {
            var peer = {};
            peer.peerConnection = new RTCPeerConnection(pc_config, {
                optional: [{
                    RtpDataChannels: true
                }]
            });
            peer.peerConnection.addStream(localStream);
            peer.dataChannel = peer.peerConnection.createDataChannel("dataChannel", {
                reliable: false
            });
            peer.dataChannel.onmessage = function(e) {
                if (peer.onDataChannelMessage) {
                    peer.onDataChannelMessage(e.data);
                }
            };
            $scope.$on("startTalking", function() {
                peer.dataChannel.send("startTalking");
            });
            $scope.$on("stopTalking", function() {
                peer.dataChannel.send("stopTalking");
            });
            peer.peerConnection.onicecandidate = function(event) {
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
            peer.peerConnection.onaddstream = function(event) {
                $scope.$apply(function() {
                    peer.stream = event.stream;
                });
            };
            peer.peerConnection.onremovestream = function() {
                $scope.$apply(function() {
                    peer.stream = null;
                });
            };
            return peer;
        }

        function handleError(error) {
            console.log("Something went wrong", error);
        }

        function getRoom() {
            return /^\/rooms\/([a-z0-9A-Z]+)/.exec(location.pathname)[1];
        }

        $scope.self = {
            isSelf: true
        };
        $scope.room = room;
        $scope.peers = peers;
        $scope.participantsCount = function() {
            return Object.keys(peers).length + 1;
        };
    });
})();
