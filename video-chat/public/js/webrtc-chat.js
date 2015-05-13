(function () {
	var config = {
		stunServers: [
			'stun.l.google.com:19302',
			'stun.services.mozilla.com',
		]
	};

	// Setup WebRTC functions:
	// 1. WebKit browsers require webkit prefix
	// 2. Firefox requires moz prefix
	
	var RTCPeerConnection = window.RTCPeerConnection
		|| window.webkitRTCPeerConnection
		|| window.mozRTCPeerConnection;

	var RTCSessionDescription = window.RTCSessionDescription
		|| window.webkitRTCSessionDescription
		|| window.mozRTCSessionDescription;

	var RTCIceCandidate = window.RTCIceCandidate
		|| window.webkitRTCIceCandidate
		|| window.mozRTCIceCandidate;

	var getUserMedia = null;
	var connectToVideoStream = null;

	if (navigator.getUserMedia) {
		getUserMedia = navigator.getUserMedia.bind(navigator);

		connectToVideoStream = function (stream, controlId) {
			var control = document.getElementById(controlId);
			control.srcObject = stream;
			control.play();
		};
	} else if (navigator.webkitGetUserMedia) {
		getUserMedia = navigator.webkitGetUserMedia.bind(navigator);

		connectToVideoStream = function (stream, controlId) {
			var control = document.getElementById(controlId);
			control.src = URL.createObjectURL(stream);
			control.play();
		};
	} else if (navigator.mozGetUserMedia) {
		getUserMedia = navigator.mozGetUserMedia.bind(navigator);

		connectToVideoStream = function (stream, controlId) {
			var control = document.getElementById(controlId);
			control.mozSrcObject = stream;
			control.play();
		};
	}

	// -------------------------

	// Peer-to-peer chat

	function Room(roomId) {
		var me = this;
		this.roomId = roomId;
		this.signalServer = io();
		this.chatChannel = null;
		this.fileChannel = null;
		this.peerConnection = new RTCPeerConnection({
			iceServers: config.stunServers.map(function (server) {
				return {
					url: 'stun:' + server
				}
			})
		}, {
			optional: []
		});

		this.peerConnection.onicecandidate = function (iceEvent) {
			if (iceEvent.candidate === undefined || iceEvent.candidate === null) {
				return;
			}

			me.signalServer.emit('new-ice-candidate', { candidate: iceEvent.candidate });
		};

		this.peerConnection.onaddstream = function (event) {
			connectToVideoStream(event.stream, 'remote-video');
		};

		this.signalServer.on('leave', function () {
			alert('Your parthner left the chat.');
			location.href = "/";
		});

		this.signalServer.on('joined', function (data) {
			function generateRoomUrl(roomId) {
				var url = location.protocol + '//' + location.host + '/' + roomId;
				return url;
			}

			function setupVideo(afterVideoSetup) {
				getUserMedia({
					video: true,
					audio: true
				}, function (localStream) {
					connectToVideoStream(localStream, 'local-video');
					me.peerConnection.addStream(localStream);

					// http://stackoverflow.com/questions/11794305/i-am-not-able-to-receive-remote-video-stream
					//
					// 'the above code pasted contains a small bug, the stream should be added to the peer connection 
					// before generating the answer or offer , that is "addStream" should be called before 
					// any of setlocalDescription or setRemoteDescription calls.'
					//
					// We should continue with WebRTC setup only when local stream
					// has been added to the WebRTC peer connection
					
					afterVideoSetup();

				}, handleError);
			}

			function newDescriptionCreated(description) {
				me.peerConnection.setLocalDescription(description, function () {
					me.signalServer.emit('new-description', { sdp: description });
				}, handleError);
			}

			function showChatMessage(msg) {
				var $content;
				if (typeof msg == 'string') {
					$content = $('<div />').text(msg);
				} else if (typeof msg == 'object') {
					var url = URL.createObjectURL(msg.data)
					$content = $('<a />').attr('href', url)
										 .attr('download', msg.name)
										 .text(msg.name);

					$content = $('<div />').append($content);
				} else {
					return;
				}

				var chatWindow = document.getElementById('chat-window');
				$(chatWindow).append($content);
				chatWindow.scrollTop = chatWindow.scrollHeight;
			}

			function setupTextChat() {
				if (me.chatChannel === null) {
					return;
				}

				var $sendMessage = $('#send-message');

				me.chatChannel.onopen = function () {
					$sendMessage.removeAttr('disabled');
				};

				me.chatChannel.onmessage = function (event) {
					showChatMessage(event.data);
				};

				$sendMessage.click(function () {
					if (me.chatChannel === null) {
						return;
					}

					var text = $('#message').val();
					me.chatChannel.send(text);
					showChatMessage(text);
					$('#message').val('');
				});
			}

			function setupFileChannel() {
				if (me.fileChannel == null) {
					return;
				}

				var $sendFile = $('#send-file'),
					$progressbar = $('#progressbar'),
					chunkSize = 10240;
					transferingFile = null,
					isReceivingData = false,
					expectedFileSize = 0,
					receivedFilename = '',
					receivedData = [],
					receivedDataSize = 0;

				// We use Signalling Channel to transfer information about file name and 
				// size. Instead of using main signallin server we could create a signalling
				// data channel to send file name and size

				me.signalServer.on('send-file', function (fileInfo) {
					isReceivingData = true;
					expectedFileSize = fileInfo.size;
					receivedFilename = fileInfo.name;
					receivedDataSize = 0;
					receivedData = [];

					$progressbar.css('width', '0%');
					me.signalServer.emit('send-file-accepted');
				});

				me.signalServer.on('send-file-accepted', function() {
					if (transferingFile == null) {
						return;
					}

					$progressbar.css('width', '0%');

					// Sending file
					// ------------------------------------------------------------------------

					var sliceFileAndSend = function (offset) {
						var reader = new window.FileReader();
						reader.onload = function (e) {
							// 1. Send chunk to the peer
							me.fileChannel.send(e.target.result);

							// 2. Update progress bar
							offset += chunkSize;
							var progress = Math.ceil(offset * 100 / transferingFile.size);
							if (progress > 100) {
								progress = 100;
							}

							$progressbar.css('width', progress + '%');

							// 3. Send another chunk if needed
							if (transferingFile.size > offset) {
								window.setTimeout(sliceFileAndSend, 0, offset);
							}
						}

						var chunk = transferingFile.slice(offset, offset + chunkSize);
						reader.readAsArrayBuffer(chunk);
					};

					sliceFileAndSend(0);
				});

				me.fileChannel.onopen = function () {
					$sendFile.removeAttr('disabled');
				};

				me.fileChannel.onmessage = function (event) {
					if (!isReceivingData) {
						return;
					}

					// Receiving file
					// ------------------------------------------------------------------------

					// 1. Save chunk
					receivedData.push(event.data);
					receivedDataSize += chunkSize;

					// 2. Update progress bar
					var progress = Math.ceil(receivedDataSize * 100 / expectedFileSize);
					if (progress > 100) {
						progress = 100;
					}

					$progressbar.css('width', progress + '%');

					// 3. Show Download URL when all chunks have been received
					if (receivedDataSize >= expectedFileSize) {
						var receivedFile = new window.Blob(receivedData);
						showChatMessage({
							name: receivedFilename,
							data: receivedFile
						});
					}
				};

				$sendFile.click(function () {
					if (me.fileChannel == null) {
						return;
					}

					var fileControl = document.getElementById('file');
					if (fileControl.files.length == 0) {
						alert('Please choose a file you want to send to your parthner.');
						return;
					}

					transferingFile = fileControl.files[0];
					me.signalServer.emit('send-file', {
						name: transferingFile.name,
						size: transferingFile.size
					});

					fileControl.value = null;
				})
			}

			function setupCaller() {
				// Beginning of text chat/file transfer

				me.chatChannel = me.peerConnection.createDataChannel('chat');
				setupTextChat();

				me.fileChannel = me.peerConnection.createDataChannel('file');
				me.fileChannel.binaryType = 'arraybuffer';
				setupFileChannel();

				// End of text chat/file transfer

				me.signalServer.on('callee-arrived', function () {
					me.peerConnection.createOffer(newDescriptionCreated, handleError);
				});

				me.signalServer.on('new-ice-candidate', function (iceEvent) {
					me.peerConnection.addIceCandidate(new RTCIceCandidate(iceEvent.candidate));
				});

				me.signalServer.on('new-description', function (description) {
					me.peerConnection.setRemoteDescription(
						new RTCSessionDescription(description.sdp),
						function () {}, 
						handleError);
				});
			}

			function setupCallee() {
				// Beginning of text chat/file transfer

				me.peerConnection.ondatachannel = function (event) {
					if (event.channel.label == "chat") {
						me.chatChannel = event.channel;
						setupTextChat();

						// This is wrong becaue the channel hasn't been initialized yet.
						// We have to wait till onopen event is raised.
						// Code:
						// me.chatChannel.send('ok');
					} else if (event.channel.label = "file") {
						me.fileChannel = event.channel;
						me.fileChannel.binaryType = 'arraybuffer';
						setupFileChannel();
					}
				};

				// End of text chat/file transfer

				me.signalServer.on('new-ice-candidate', function (iceEvent) {
					me.peerConnection.addIceCandidate(new RTCIceCandidate(iceEvent.candidate));
				});

				me.signalServer.on('new-description', function (description) {
					me.peerConnection.setRemoteDescription(
						new RTCSessionDescription(description.sdp),
						function () {
							me.peerConnection.createAnswer(newDescriptionCreated, handleError);
						}, 
						handleError);
				});	

				me.signalServer.emit('callee-arrived');				
			}

			function handleError(error) {
				console.log(error);
			}

			if (!data.isJoined) {
				alert('You cannot join this conversation. Please try again or create new conversation.');
				return;
			} else {
				me.isCaller = data.isCaller;

				var url = generateRoomUrl(me.roomId);
				$('#chat-url').text(url);
				$('#chat-url').attr('href', url);
				$('#login').hide();
				$('#chat').show();

				setupVideo(function () {
					if (me.isCaller) {
						setupCaller();
					} else {
						setupCallee(); 
					}
				});
			}
		});
	}

	Room.prototype.join = function () {
		this.signalServer.emit('join', { id: this.roomId });
	}

	// -------------------------

	function isWebRTCSupported() {
		return getUserMedia;
	}

	function joinChat() {
		var roomId = $('#room-id').val();
		if (roomId === '') {
			alert('Room name cannot be empty.');
			return;
		}

		var room = new Room(roomId);
		room.join();
	}

	$(document).ready(function () {
		if (!isWebRTCSupported()) {
			$('.has-webrtc').hide();
			$('#webrtc-not-supported').show();
			return;
		}

		$('#join-chat').click(function () {
			joinChat();
		})
	});
})();