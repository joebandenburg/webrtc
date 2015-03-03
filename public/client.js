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
        var samples = 512;
        var smoothing = 0.1;
        var threshold = -60;

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
                analyser.smoothingTimeConstant = smoothing;
                source.connect(analyser);
                var fftBins = new Float32Array(samples);

                var isTalking = false;
                var clear = _.debounce(function() {
                    $scope.$broadcast("stopTalking");
                    isTalking = false;
                }, 200);

                $interval(function() {
                    if ($scope.self.muted) {
                        return;
                    }
                    analyser.getFloatFrequencyData(fftBins);
                    var maxVolume = -Infinity;
                    for (var i = 4; i < samples; i++) {
                        if (fftBins[i] > maxVolume && fftBins[i] < 0) {
                            maxVolume = fftBins[i];
                        }
                    }
                    if (maxVolume > threshold) {
                        if (!isTalking) {
                            isTalking = true;
                            $scope.$broadcast("startTalking");
                        }
                        clear();
                    }
                }, 100);

                $scope.$apply(function() {
                    $scope.self.stream = stream;
                });
                ws.send(JSON.stringify({
                    type: "join"
                }));
                $scope.$watch("self.muted", function(value) {
                    localStream.getAudioTracks().forEach(function(audioTrack) {
                        audioTrack.enabled = !value;
                    });
                    if (value) {
                        $scope.$broadcast("stopTalking");
                    }
                });
            }, handleError("getUserMedia"));
        };
        ws.onmessage = function(event) {
            $scope.$apply(function() {
                var message = JSON.parse(event.data);
                console.log(message);
                switch (message.type) {
                    case "join":
                        peers[message.id] = createPeer(message.id);
                        var peerConnection = peers[message.id].peerConnection;
                        peerConnection.ondatachannel({
                            channel: peerConnection.createDataChannel("dataChannel")
                        });
                        peerConnection.createOffer(function(sessionDescription) {
                            peerConnection.setLocalDescription(sessionDescription, function() {
                                ws.send(JSON.stringify({
                                    type: "offer",
                                    to: message.id,
                                    description: sessionDescription
                                }));
                            }, handleError("handle join - setLocalDescription"));
                        }, handleError("handle join - createOffer"));
                        break;
                    case "leave":
                        if (peers[message.id]) {
                            peers[message.id].$destroy();
                            delete peers[message.id];
                        }
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
                                }, handleError("handle offer - setLocalDescription"));
                            }, handleError("handle offer - createAnswer"));
                        }, handleError("handle offer - setRemoteDescription"));
                        break;
                    case "answer":
                        var peerConnection = peers[message.id].peerConnection;
                        peerConnection.setRemoteDescription(new RTCSessionDescription(message.description),
                            function() {},
                            handleError("handle answer - setRemoteDescription"));
                        break;
                    case "candidate":
                        var peerConnection = peers[message.id].peerConnection;
                        var candidate = new RTCIceCandidate({
                            sdpMLineIndex: message.label,
                            sdpMid: message.sdpMid,
                            candidate: message.candidate
                        });
                        peerConnection.addIceCandidate(candidate, function() {},
                            handleError("handle candidate - addIceCandidate"));
                        break;
                }
            });
        };

        function createPeer(forId) {
            var peer = $scope.$new();
            peer.muted = false;
            peer.peerConnection = new RTCPeerConnection(pc_config, {
                optional: [{
                    DtlsSrtpKeyAgreement: true
                }]
            });
            peer.peerConnection.addStream(localStream);
            peer.$on("startTalking", function() {
                if (peer.dataChannel) {
                    peer.dataChannel.send("startTalking");
                }
            });
            peer.$on("stopTalking", function() {
                if (peer.dataChannel) {
                    peer.dataChannel.send("stopTalking");
                }
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
            peer.peerConnection.ondatachannel = function(event) {
                peer.dataChannel = event.channel;
                peer.dataChannel.onerror = handleError("data channel");
                peer.dataChannel.onmessage = function(e) {
                    if (peer.onDataChannelMessage) {
                        peer.onDataChannelMessage(e.data);
                    }
                };
            };
            peer.$watch("muted", function(value) {
                if (peer.stream) {
                    peer.stream.getAudioTracks().forEach(function(audioTrack) {
                        audioTrack.enabled = !value;
                    });
                }
            });
            return peer;
        }

        function handleError(location) {
            return function(error) {
                console.log("Something went wrong in", location, error);
            };
        };

        function getRoom() {
            return /^\/rooms\/([a-z0-9A-Z]+)/.exec(location.pathname)[1];
        }

        $scope.self = {
            isSelf: true,
            muted: false
        };
        $scope.room = room;
        $scope.peers = peers;
        $scope.participantsCount = function() {
            return Object.keys(peers).length + 1;
        };
    });
})();
