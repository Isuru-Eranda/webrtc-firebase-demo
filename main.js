import './style.css';

import firebase from 'firebase/app';
import 'firebase/firestore';

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCVP5hR_aPRoV9_OokLeG2K4n3jfBiGUX8",
  authDomain: "webrtc-aa565.firebaseapp.com",
  projectId: "webrtc-aa565",
  storageBucket: "webrtc-aa565.firebasestorage.app",
  messagingSenderId: "312907534115",
  appId: "1:312907534115:web:b7aaf86925653766a2c696"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const firestore = firebase.firestore();

const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 10,
};

// Global State
const pc = new RTCPeerConnection(servers);
let localStream = null;
let remoteStream = null;
let currentCallId = null;
let callRole = null; // 'caller' or 'answerer'

// HTML elements
const webcamButton = document.getElementById('webcamButton');
const webcamVideo = document.getElementById('webcamVideo');
const callButton = document.getElementById('callButton');
const callInput = document.getElementById('callInput');
const answerButton = document.getElementById('answerButton');
const remoteVideo = document.getElementById('remoteVideo');
const hangupButton = document.getElementById('hangupButton');

// Debug elements
const debugElements = {
  state: document.getElementById('dbg-state'),
  ice: document.getElementById('dbg-ice'),
  signaling: document.getElementById('dbg-signaling'),
  localCodec: document.getElementById('dbg-local-codec'),
  localBitrate: document.getElementById('dbg-local-bitrate'),
  localSample: document.getElementById('dbg-local-sample'),
  localChannels: document.getElementById('dbg-local-channels'),
  localBytes: document.getElementById('dbg-local-bytes'),
  remoteCodec: document.getElementById('dbg-remote-codec'),
  remoteBitrate: document.getElementById('dbg-remote-bitrate'),
  remoteSample: document.getElementById('dbg-remote-sample'),
  remoteChannels: document.getElementById('dbg-remote-channels'),
  remoteBytes: document.getElementById('dbg-remote-bytes'),
  remoteLost: document.getElementById('dbg-remote-lost'),
  candidates: document.getElementById('dbg-candidates'),
  route: document.getElementById('dbg-route'),
  rtt: document.getElementById('dbg-rtt'),
  callId: document.getElementById('dbg-callid'),
  role: document.getElementById('dbg-role'),
};

// Track stats
let localStats = { bytes: 0 };
let remoteStats = { bytes: 0 };
let candidateCount = 0;

// Debug update function
async function updateDebugStats() {
  try {
    // Connection states
    debugElements.state.textContent = pc.connectionState || '-';
    debugElements.ice.textContent = pc.iceConnectionState || '-';
    debugElements.signaling.textContent = pc.signalingState || '-';

    console.log('=== DEBUG STATS ===');
    console.log('Connection State:', pc.connectionState);
    console.log('ICE State:', pc.iceConnectionState);
    console.log('Signaling State:', pc.signalingState);

    // Get RTCStats
    const stats = await pc.getStats();
    let localCodec = '-', localBitrate = '-', localSample = '-', localChannels = '-';
    let remoteCodec = '-', remoteBitrate = '-', remoteSample = '-', remoteChannels = '-';
    let currentRoute = '-', rtt = '-', remoteLost = 0;

    stats.forEach((report) => {
      if (report.type === 'outbound-rtp' && report.mediaType === 'audio') {
        localStats.bytes = report.bytesSent || 0;
        debugElements.localBytes.textContent = (localStats.bytes / 1024).toFixed(1) + ' KB';
        
        const elapsed = report.timestamp - (report._lastTimestamp || report.timestamp);
        const bytesDelta = (report.bytesSent || 0) - (report._lastBytesSent || 0);
        if (elapsed > 0 && bytesDelta >= 0) {
          const bitrate = (bytesDelta * 8 * 1000 / elapsed / 1000).toFixed(1);
          debugElements.localBitrate.textContent = bitrate + ' kbps';
        }
        report._lastTimestamp = report.timestamp;
        report._lastBytesSent = report.bytesSent || 0;
      }

      if (report.type === 'inbound-rtp' && report.mediaType === 'audio') {
        remoteStats.bytes = report.bytesReceived || 0;
        debugElements.remoteBytes.textContent = (remoteStats.bytes / 1024).toFixed(1) + ' KB';
        remoteLost = report.packetsLost || 0;
        debugElements.remoteLost.textContent = remoteLost;
        
        const elapsed = report.timestamp - (report._lastTimestamp || report.timestamp);
        const bytesDelta = (report.bytesReceived || 0) - (report._lastBytesReceived || 0);
        if (elapsed > 0 && bytesDelta >= 0) {
          const bitrate = (bytesDelta * 8 * 1000 / elapsed / 1000).toFixed(1);
          debugElements.remoteBitrate.textContent = bitrate + ' kbps';
        }
        report._lastTimestamp = report.timestamp;
        report._lastBytesReceived = report.bytesReceived || 0;
      }

      if (report.type === 'codec' && report.mimeType && report.mimeType.includes('audio')) {
        if (report._associated === 'outbound') {
          localCodec = report.mimeType.split('/')[1].toUpperCase() || 'Unknown';
          localSample = report.clockRate ? (report.clockRate / 1000) + ' kHz' : '-';
          localChannels = report.channels || '-';
        }
        if (report._associated === 'inbound') {
          remoteCodec = report.mimeType.split('/')[1].toUpperCase() || 'Unknown';
          remoteSample = report.clockRate ? (report.clockRate / 1000) + ' kHz' : '-';
          remoteChannels = report.channels || '-';
        }
      }

      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        currentRoute = `${report.protocol || '?'}/${report.candidateType || '?'}`;
        rtt = report.currentRoundTripTime ? (report.currentRoundTripTime * 1000).toFixed(1) + ' ms' : '-';
      }
    });

    debugElements.localCodec.textContent = localCodec;
    debugElements.localSample.textContent = localSample;
    debugElements.localChannels.textContent = localChannels;
    debugElements.remoteCodec.textContent = remoteCodec;
    debugElements.remoteSample.textContent = remoteSample;
    debugElements.remoteChannels.textContent = remoteChannels;
    debugElements.route.textContent = currentRoute;
    debugElements.rtt.textContent = rtt;
    debugElements.candidates.textContent = candidateCount;
    debugElements.callId.textContent = currentCallId || '-';
    debugElements.role.textContent = callRole || '-';

    console.log('Local Audio:', { codec: localCodec, bitrate: localBitrate, sample: localSample, channels: localChannels, bytes: localStats.bytes });
    console.log('Remote Audio:', { codec: remoteCodec, bitrate: remoteBitrate, sample: remoteSample, channels: remoteChannels, bytes: remoteStats.bytes, lost: remoteLost });
    console.log('Network:', { route: currentRoute, rtt: rtt, candidates: candidateCount });
    console.log('Call Info:', { callId: currentCallId, role: callRole });
    console.log('==================');
  } catch (e) {
    console.warn('Error updating debug stats:', e);
  }
}

// Update debug stats every 500ms when connected
setInterval(() => {
  if (pc.connectionState === 'connected') {
    updateDebugStats();
  }
}, 500);

// Listen to connection state changes
pc.onconnectionstatechange = () => {
  debugElements.state.textContent = pc.connectionState || '-';
  console.log('=== CONNECTION STATE CHANGED ===');
  console.log('Connection state:', pc.connectionState);
  console.log('ICE state:', pc.iceConnectionState);
  console.log('Signaling state:', pc.signalingState);
  console.log('================================');
};

pc.oniceconnectionstatechange = () => {
  debugElements.ice.textContent = pc.iceConnectionState || '-';
  console.log('=== ICE CONNECTION STATE CHANGED ===');
  console.log('ICE state:', pc.iceConnectionState);
  console.log('Connection state:', pc.connectionState);
  console.log('Signaling state:', pc.signalingState);
  console.log('====================================');
};

pc.onsignalingstatechange = () => {
  debugElements.signaling.textContent = pc.signalingState || '-';
  console.log('=== SIGNALING STATE CHANGED ===');
  console.log('Signaling state:', pc.signalingState);
  console.log('Connection state:', pc.connectionState);
  console.log('ICE state:', pc.iceConnectionState);
  console.log('===============================');
};

webcamButton.onclick = async () => {
  // High-quality audio constraints optimized for music
  const constraints = {
    audio: {
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };

  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  remoteStream = new MediaStream();

  // Push tracks from local stream to peer connection
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  // Pull tracks from remote stream, add to audio stream
  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      remoteStream.addTrack(track);
    });
  };

  // Create audio elements for playback (instead of video)
  const localAudio = document.getElementById('webcamVideo');
  localAudio.srcObject = localStream;

  const remoteAudio = document.getElementById('remoteVideo');
  remoteAudio.srcObject = remoteStream;

  // Try to raise audio sender bitrate for music (client-side)
  try {
    const audioSender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
    if (audioSender) {
      const params = audioSender.getParameters();
      params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
      // Set a high max bitrate (e.g. 192-256 kbps). Adjust to network capacity.
      params.encodings[0].maxBitrate = 256000;
      await audioSender.setParameters(params);
    }
  } catch (e) {
    console.warn('setParameters for audio sender failed, continuing. Fallback to SDP tweaks later.', e);
  }

  callButton.disabled = false;
  answerButton.disabled = false;
  webcamButton.disabled = true;

  // Update UI with stream info
  const streamStatus = document.getElementById('streamStatus');
  if (streamStatus) {
    streamStatus.textContent = 'Status: Microphone active ✓';
    streamStatus.className = 'status-active';
  }

  // Update debug info
  debugElements.state.textContent = pc.connectionState || 'new';
  debugElements.ice.textContent = pc.iceConnectionState || 'new';
  debugElements.signaling.textContent = pc.signalingState || 'stable';
  
  updateDebugStats();
};

// 2. Create an offer
callButton.onclick = async () => {
  // Reference Firestore collections for signaling
  const callDoc = firestore.collection('calls').doc();
  currentCallId = callDoc.id;
  callRole = 'caller';
  const offerCandidates = callDoc.collection('offerCandidates');
  const answerCandidates = callDoc.collection('answerCandidates');

  callInput.value = callDoc.id;

  // Get candidates for caller, save to db
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      candidateCount++;
      debugElements.candidates.textContent = candidateCount;
      offerCandidates.add(event.candidate.toJSON());
    }
  };

  // Create offer
  let offerDescription = await pc.createOffer();

  // Prefer Opus stereo and bump Opus maxaveragebitrate in SDP as a fallback
  offerDescription.sdp = preferOpusStereo(offerDescription.sdp, 256000);

  await pc.setLocalDescription(offerDescription);

  const offer = {
    sdp: offerDescription.sdp,
    type: offerDescription.type,
  };

  await callDoc.set({ offer });

  document.getElementById('callStatus').textContent = 'Status: Call created (waiting for answer)';
  document.getElementById('callStatus').className = 'status-active';
  updateDebugStats();

  // Listen for remote answer
  callDoc.onSnapshot((snapshot) => {
    const data = snapshot.data();
    if (!pc.currentRemoteDescription && data?.answer) {
      const answerDescription = new RTCSessionDescription(data.answer);
      pc.setRemoteDescription(answerDescription);
    }
  });

  // When answered, add candidate to peer connection
  answerCandidates.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        const candidate = new RTCIceCandidate(change.doc.data());
        pc.addIceCandidate(candidate);
      }
    });
  });

  hangupButton.disabled = false;
};

// 3. Answer the call with the unique ID
answerButton.onclick = async () => {
  const callId = callInput.value;
  currentCallId = callId;
  callRole = 'answerer';
  const callDoc = firestore.collection('calls').doc(callId);
  const answerCandidates = callDoc.collection('answerCandidates');
  const offerCandidates = callDoc.collection('offerCandidates');

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      candidateCount++;
      debugElements.candidates.textContent = candidateCount;
      answerCandidates.add(event.candidate.toJSON());
    }
  };

  const callData = (await callDoc.get()).data();

  const offerDescription = callData.offer;
  await pc.setRemoteDescription(new RTCSessionDescription(offerDescription));

  const answerDescription = await pc.createAnswer();

  // SDP tweak for Opus stereo fallback
  answerDescription.sdp = preferOpusStereo(answerDescription.sdp, 256000);

  await pc.setLocalDescription(answerDescription);

  const answer = {
    type: answerDescription.type,
    sdp: answerDescription.sdp,
  };

  await callDoc.update({ answer });

  document.getElementById('answerStatus').textContent = 'Status: Call answered ✓';
  document.getElementById('answerStatus').className = 'status-active';
  updateDebugStats();

  offerCandidates.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      console.log(change);
      if (change.type === 'added') {
        let data = change.doc.data();
        pc.addIceCandidate(new RTCIceCandidate(data));
      }
    });
  });

  hangupButton.disabled = false;
};

// Hangup handler
hangupButton.onclick = () => {
  localStream?.getTracks().forEach((track) => track.stop());
  pc.close();
  location.reload();
};

// Monitor connection state
pc.onconnectionstatechange = () => {
  updateDebugStats();
};

pc.oniceconnectionstatechange = () => {
  updateDebugStats();
};

// Helper: enable opus stereo & set maxaveragebitrate in SDP for browsers that need it.
// bitrate in bps (e.g. 256000)
function preferOpusStereo(sdp, bitrate) {
  if (!sdp) return sdp;
  // find opus payload
  const lines = sdp.split('\r\n');
  let opusPayload = null;
  for (const line of lines) {
    if (line.startsWith('a=rtpmap') && line.toLowerCase().includes('opus/48000')) {
      opusPayload = line.split(' ')[0].split(':')[1];
      break;
    }
  }
  if (!opusPayload) return sdp;

  // find existing fmtp for opus
  const fmtpIndex = lines.findIndex((l) => l.startsWith('a=fmtp:' + opusPayload));
  const stereoParam = 'stereo=1;sprop-stereo=1';
  const bitrateParam = bitrate ? `maxaveragebitrate=${bitrate}` : null;

  if (fmtpIndex !== -1) {
    // append params if not present
    if (!lines[fmtpIndex].includes('stereo=1')) {
      lines[fmtpIndex] = lines[fmtpIndex] + ';' + stereoParam;
    }
    if (bitrateParam && !lines[fmtpIndex].includes('maxaveragebitrate')) {
      lines[fmtpIndex] = lines[fmtpIndex] + ';' + bitrateParam;
    }
  } else {
    // insert a new fmtp line after a=rtpmap for opus
    const rtpIndex = lines.findIndex((l) => l.startsWith('a=rtpmap:' + opusPayload));
    const params = [stereoParam, bitrateParam].filter(Boolean).join(';');
    lines.splice(rtpIndex + 1, 0, `a=fmtp:${opusPayload} ${params}`);
  }

  return lines.join('\r\n');
}
