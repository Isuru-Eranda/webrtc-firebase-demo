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

console.log('🔥 Initializing Firebase...');
if (!firebase.apps.length) {
  console.log('📝 Firebase apps not found, initializing...');
  firebase.initializeApp(firebaseConfig);
  console.log('✅ Firebase initialized successfully');
} else {
  console.log('✅ Firebase already initialized');
}

console.log('🔥 Getting Firestore instance...');
const firestore = firebase.firestore();
console.log('✅ Firestore instance ready');

console.log('🔥 Configuring ICE servers...');

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

// ============ GLOBAL STATE ============
let localStream = null;
let currentRoomId = null;
let currentUserId = null;
let isJoiningRoom = false; // Prevent concurrent room joins

// Map of peerId -> { pc: RTCPeerConnection, remoteStream: MediaStream }
const peers = new Map();

// Audio context for mixing (optional, for advanced mixing)
let audioContext = null;
let audioDestination = null;

// Diagnostic function to check system status
async function logDiagnostics() {
  console.log('🔍 === SYSTEM DIAGNOSTICS ===');
  console.log('🌐 Network Status:');
  console.log('  Online:', navigator.onLine);
  console.log('  User Agent:', navigator.userAgent.substring(0, 80));
  
  console.log('🔥 Firebase Status:');
  try {
    const testWrite = await firestore.collection('_diagnostics').doc('test-' + Date.now()).set({test: true});
    console.log('  ✅ Firebase write test: SUCCESS');
  } catch (e) {
    console.error('  ❌ Firebase write test FAILED:', e.message);
  }
  
  console.log('🌍 Connection Info:');
  console.log('  Location:', window.location.href);
  console.log('  Firestore Project:', firebaseConfig.projectId);
}

// HTML elements
const webcamButton = document.getElementById('webcamButton');
const callButton = document.getElementById('callButton');
const callInput = document.getElementById('callInput');
const answerButton = document.getElementById('answerButton');
const hangupButton = document.getElementById('hangupButton');

// Debug elements
const debugElements = {
  state: document.getElementById('dbg-state'),
  ice: document.getElementById('dbg-ice'),
  signaling: document.getElementById('dbg-signaling'),
  callId: document.getElementById('dbg-callid'),
  role: document.getElementById('dbg-role'),
};

// ============ UTILITY FUNCTIONS ============

// Generate a unique user ID
function generateUserId() {
  return 'user-' + Math.random().toString(36).substr(2, 9);
}

// Modify SDP to prefer Opus stereo with high bitrate
function preferOpusStereo(sdp) {
  const lines = sdp.split('\n');
  let opusPayloadType = null;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('opus/48000')) {
      const match = lines[i].match(/a=rtpmap:(\d+) opus/);
      if (match) opusPayloadType = match[1];
    }
  }

  if (opusPayloadType) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('a=fmtp:' + opusPayloadType)) {
        lines[i] = `a=fmtp:${opusPayloadType} maxaveragebitrate=256000; stereo=1; sprop-stereo=1`;
      }
    }
  }

  return lines.join('\n');
}

// Update debug display and status
function updateDebugDisplay() {
  debugElements.state.textContent = `Peers: ${peers.size}`;
  debugElements.ice.textContent = `Room: ${currentRoomId || 'N/A'}`;
  debugElements.signaling.textContent = `User: ${currentUserId || 'N/A'}`;
  debugElements.callId.textContent = currentRoomId || '-';
  debugElements.role.textContent = `${peers.size} connected`;

  // Update status elements if they exist
  const streamStatus = document.getElementById('streamStatus');
  if (streamStatus) {
    if (localStream) {
      streamStatus.textContent = '✅ Status: Microphone ON';
      streamStatus.className = 'status-active';
    } else {
      streamStatus.textContent = '❌ Status: Microphone OFF';
      streamStatus.className = 'status-idle';
    }
  }

  const roomInfo = document.getElementById('roomInfo');
  if (roomInfo && currentRoomId) {
    roomInfo.style.display = 'block';
    roomInfo.innerHTML = `<strong>📍 Connected to room:</strong> <code>${currentRoomId}</code><br><strong>👤 Your ID:</strong> <code>${currentUserId}</code><br><strong>👥 Peers:</strong> ${peers.size}`;
    roomInfo.style.background = '#e8f5e9';
    roomInfo.style.padding = '10px';
    roomInfo.style.borderRadius = '4px';
    roomInfo.style.marginTop = '10px';
    roomInfo.style.border = '1px solid #4CAF50';
  }

  // Update peers list
  const peersList = document.getElementById('peersList');
  if (peersList) {
    if (peers.size === 0) {
      if (currentRoomId) {
        peersList.innerHTML = '<p class="status-idle">Waiting for other peers to join...</p>';
      } else {
        peersList.innerHTML = '<p class="status-idle">Not connected to any room</p>';
      }
    } else {
      let html = '';
      peers.forEach((peer, peerId) => {
        const status = peer.pc.connectionState === 'connected' ? 'connected' : 'connecting';
        const statusClass = status === 'connected' ? '' : ' offline';
        html += `<div class="peer-item${statusClass}">
          <strong>${peerId.substr(0, 12)}...</strong><br>
          <small>Connection: <code>${peer.pc.connectionState}</code></small>
        </div>`;
      });
      peersList.innerHTML = html;
    }
  }
}

// ============ PEER CONNECTION SETUP ============

async function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(servers);

  // Add local stream tracks to this peer connection
  if (localStream) {
    console.log(`  🎙️ Adding local audio tracks to peer ${peerId}`);
    const audioTracks = localStream.getAudioTracks();
    console.log(`    Found ${audioTracks.length} audio tracks`);
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  } else {
    console.warn(`  ⚠️ WARNING: localStream is NULL - no audio tracks added to peer ${peerId}`);
  }

  // Create remote stream for this peer
  const remoteStream = new MediaStream();
  pc.ontrack = (event) => {
    console.log('Received track from', peerId);
    event.streams[0].getTracks().forEach((track) => {
      remoteStream.addTrack(track);
    });
  };

  // Set high bitrate for audio
  pc.onconnectionstatechange = () => {
    console.log(`Peer ${peerId} connection state:`, pc.connectionState);
    if (pc.connectionState === 'connected') {
      // Set audio sender parameters for high bitrate (Firefox compatible)
      const audioSender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (audioSender) {
        try {
          // Firefox requires getParameters before setParameters
          const params = audioSender.getParameters();
          if (params.encodings && params.encodings.length > 0) {
            params.encodings[0].maxBitrate = 256000;
            audioSender.setParameters(params).catch((e) => {
              console.warn(`Could not set bitrate for ${peerId}:`, e.message);
            });
          }
        } catch (e) {
          console.warn(`Could not configure audio bitrate for ${peerId}:`, e.message);
        }
      }
    }
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      removePeer(peerId);
    }
    updateDebugDisplay();
  };

  // Handle ICE candidates
  pc.onicecandidate = async (event) => {
    if (event.candidate) {
      try {
        await firestore.collection('rooms').doc(currentRoomId).collection('peers').doc(currentUserId).collection('candidates').add({
          candidate: event.candidate.candidate,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          sdpMid: event.candidate.sdpMid,
          forPeer: peerId,
          timestamp: new Date(),
        });
      } catch (err) {
        console.error('Error adding ICE candidate:', err);
      }
    }
  };

  // Store in peers map early so listeners can reference it
  peers.set(peerId, { pc, remoteStream, isInitiator, pendingOffers: [], pendingAnswers: [] });

  // Create and attach an audio element for this remote stream
  // WebRTC browser automatically mixes all audio tracks, but we need to attach to DOM for playback
  const audioElement = document.createElement('audio');
  audioElement.srcObject = remoteStream;
  audioElement.autoplay = true;
  audioElement.playsinline = true;
  audioElement.id = `audio-${peerId}`;
  audioElement.style.display = 'none'; // Hidden but still plays audio
  document.body.appendChild(audioElement);
  console.log(`  🔊 Created audio element for peer ${peerId}`);

  // Helper to attempt processing queued remote descriptions when state allows
  async function tryProcessPending() {
    const entry = peers.get(peerId);
    if (!entry) return;
    const { pc: _pc, pendingOffers, pendingAnswers } = entry;

    // If we have pending offers and we're stable, process the oldest offer
    if (pendingOffers.length > 0 && _pc.signalingState === 'stable' && !_pc.remoteDescription) {
      const offerData = pendingOffers.shift();
      try {
        console.log(`� Processing queued offer from ${peerId}...`);
        await _pc.setRemoteDescription(new RTCSessionDescription(offerData));
        const answer = await _pc.createAnswer();
        let sdp = answer.sdp;
        sdp = preferOpusStereo(sdp);
        await _pc.setLocalDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        await firestore.collection('rooms').doc(currentRoomId).collection('answers').doc(`${currentUserId}-to-${peerId}`).set({
          from: currentUserId,
          to: peerId,
          answer: { type: 'answer', sdp: _pc.localDescription.sdp },
          timestamp: new Date(),
        });
        console.log(`✅ Answer sent to ${peerId} (from queued offer)`);
      } catch (err) {
        console.error('Error processing queued offer:', err);
      }
    }

    // If we have pending answers and we're waiting for an answer, process the oldest answer
    if (pendingAnswers.length > 0 && _pc.signalingState === 'have-local-offer' && !_pc.remoteDescription) {
      const answerData = pendingAnswers.shift();
      try {
        console.log(`📥 Processing queued answer from ${peerId}...`);
        await _pc.setRemoteDescription(new RTCSessionDescription(answerData));
        console.log(`✅ Queued answer set for ${peerId}`);
      } catch (err) {
        console.error('Error processing queued answer:', err);
      }
    }
  }

  // Listen for offers from this peer (answers/responds to offers they send)
  const unsubscribeOffers = firestore
    .collection('rooms').doc(currentRoomId).collection('offers')
    .where('from', '==', peerId)
    .where('to', '==', currentUserId)
    .onSnapshot(async (snapshot) => {
      console.log(`📡 Offer listener for ${peerId}→${currentUserId}: ${snapshot.docs.length} docs`);
      for (const doc of snapshot.docChanges()) {
        if (doc.type === 'added' && doc.doc.data().offer) {
          const offerData = doc.doc.data().offer;
          console.log(`  📨 Offer document: ${doc.doc.id}`);
          const entry = peers.get(peerId);
          if (!entry) {
            console.warn(`  ⚠️ Peer ${peerId} entry not found in peers map`);
            continue;
          }
          const _pc = entry.pc;
          console.log(`  State check - remoteDesc: ${_pc.remoteDescription ? 'SET' : 'NULL'}, signalingState: ${_pc.signalingState}`);
          // If we can handle it now, do so; otherwise queue it
          if (_pc.remoteDescription === null && _pc.signalingState === 'stable') {
            try {
              console.log(`📤 Received offer from ${peerId}, creating answer...`);
              await _pc.setRemoteDescription(new RTCSessionDescription(offerData));
              const answer = await _pc.createAnswer();
              let sdp = answer.sdp;
              sdp = preferOpusStereo(sdp);
              await _pc.setLocalDescription(new RTCSessionDescription({ type: 'answer', sdp }));
              await firestore.collection('rooms').doc(currentRoomId).collection('answers').doc(`${currentUserId}-to-${peerId}`).set({
                from: currentUserId,
                to: peerId,
                answer: { type: 'answer', sdp: _pc.localDescription.sdp },
                timestamp: new Date(),
              });
              console.log(`✅ Answer sent to ${peerId}`);
            } catch (err) {
              console.error(`Error handling offer from ${peerId}:`, err);
            }
          } else {
            console.warn(`Queuing offer from ${peerId} - remoteDesc=${_pc.remoteDescription ? 'SET' : 'NULL'}, signalingState: ${_pc.signalingState}`);
            entry.pendingOffers.push(offerData);
          }
        }
      }
      // Try processing queued descriptions in case state changed
      tryProcessPending();
    });

  // Listen for answers
  const unsubscribeAnswers = firestore
    .collection('rooms').doc(currentRoomId).collection('answers')
    .where('from', '==', peerId)
    .where('to', '==', currentUserId)
    .onSnapshot(async (snapshot) => {
      console.log(`📡 Answer listener for ${peerId}→${currentUserId}: ${snapshot.docs.length} docs`);
      for (const doc of snapshot.docChanges()) {
        if (doc.type === 'added' && doc.doc.data().answer) {
          const answerData = doc.doc.data().answer;
          console.log(`  📨 Answer document: ${doc.doc.id}`);
          const entry = peers.get(peerId);
          if (!entry) {
            console.warn(`  ⚠️ Peer ${peerId} entry not found in peers map`);
            continue;
          }
          const _pc = entry.pc;
          console.log(`  State check - remoteDesc: ${_pc.remoteDescription ? 'SET' : 'NULL'}, signalingState: ${_pc.signalingState}`);
          if (_pc.remoteDescription === null && _pc.signalingState === 'have-local-offer') {
            try {
              console.log(`📥 Received answer from ${peerId}...`);
              await _pc.setRemoteDescription(new RTCSessionDescription(answerData));
              console.log(`✅ Answer set for ${peerId}`);
            } catch (err) {
              console.error(`Error setting remote description from ${peerId}:`, err);
            }
          } else {
            console.warn(`Queuing answer from ${peerId} - remoteDesc=${_pc.remoteDescription ? 'SET' : 'NULL'}, signalingState: ${_pc.signalingState}`);
            entry.pendingAnswers.push(answerData);
          }
        }
      }
    });

  // Listen for ICE candidates from this peer
  const unsubscribeCandidates = firestore
    .collection('rooms').doc(currentRoomId).collection('peers').doc(peerId).collection('candidates')
    .where('forPeer', '==', currentUserId)
    .onSnapshot(async (snapshot) => {
      for (const doc of snapshot.docChanges()) {
        if (doc.type === 'added') {
          const candidateData = doc.doc.data();
          try {
            // Add candidate when possible; addIceCandidate will queue internally in many browsers
            await pc.addIceCandidate(new RTCIceCandidate(candidateData));
          } catch (err) {
            console.error('Error adding ICE candidate:', err);
          }
        }
      }
    });

  // Store unsubscribe functions for cleanup
  peers.get(peerId).unsubscribe = () => {
    unsubscribeOffers();
    unsubscribeAnswers();
    unsubscribeCandidates();
  };

  // Determine who sends offer: alphabetically smaller ID becomes offerer (deterministic)
  const shouldSendOffer = currentUserId < peerId;

  if (shouldSendOffer) {
    // Before creating an offer, check if peer already created an offer to us. If so, become answerer.
    const existingOfferDoc = await firestore.collection('rooms').doc(currentRoomId).collection('offers').doc(`${peerId}-to-${currentUserId}`).get();
    if (existingOfferDoc.exists) {
      console.log(`📥 Found existing offer from ${peerId} - will wait and answer instead`);
    } else {
      console.log(`📤 Creating offer for peer ${peerId} (I'm offerer: ${currentUserId} < ${peerId})`);
      try {
        const offer = await pc.createOffer();
        let sdp = offer.sdp;
        sdp = preferOpusStereo(sdp);
        await pc.setLocalDescription(new RTCSessionDescription({ type: 'offer', sdp }));

        // Send offer to Firestore
        const offerDocId = `${currentUserId}-to-${peerId}`;
        console.log(`  📨 Writing offer to Firestore: ${offerDocId}`);
        await firestore.collection('rooms').doc(currentRoomId).collection('offers').doc(offerDocId).set({
          from: currentUserId,
          to: peerId,
          offer: { type: 'offer', sdp: pc.localDescription.sdp },
          timestamp: new Date(),
        });
        console.log(`  ✅ Offer written successfully`);
      } catch (err) {
        console.error('Error creating/sending offer:', err);
      }
    }
  } else {
    console.log(`📥 Waiting for offer from peer ${peerId} (I'm answerer: ${currentUserId} > ${peerId})`);
  }

  // Try processing any queued descriptions in case something arrived while we were setting up
  tryProcessPending();

  return pc;
}

// ============ ROOM & PEER MANAGEMENT ============

async function joinRoom(roomId) {
  console.log('=== JOINING ROOM ===');
  currentRoomId = roomId;
  currentUserId = generateUserId();
  updateDebugDisplay();

  console.log(`User ${currentUserId} joining room ${roomId}`);
  console.log('Registering in Firestore...');

  // Register this user in the room with timeout protection and detailed logging
  try {
    console.log('📝 Step 1: Getting Firestore reference...');
    const roomRef = firestore.collection('rooms').doc(roomId);
    console.log('✅ Got room reference for room:', roomId);
    
    console.log('📝 Step 2: Getting peers collection...');
    const peersRef = roomRef.collection('peers');
    console.log('✅ Got peers collection reference');
    
    console.log('📝 Step 3: Creating user document reference...');
    const userDocRef = peersRef.doc(currentUserId);
    console.log('✅ Got user document reference:', currentUserId);
    
    console.log('📝 Step 4: Building data object...');
    const userData = {
      userId: currentUserId,
      joinedAt: new Date(),
      isActive: true,
    };
    console.log('✅ Data object ready:', userData);
    
    console.log('📝 Step 5: Starting Firestore set() call...');
    const registrationPromise = userDocRef.set(userData);
    console.log('✅ set() call initiated (Promise created)');
    
    console.log('📝 Step 6: Creating timeout promise...');
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => {
        console.error('⏰ TIMEOUT TRIGGERED: 10 seconds elapsed!');
        reject(new Error('Firestore timeout - took more than 10 seconds'));
      }, 10000)
    );
    console.log('✅ Timeout promise ready (10 seconds)');
    
    console.log('📝 Step 7: Waiting for Promise.race()...');
    const startTime = Date.now();
    await Promise.race([registrationPromise, timeoutPromise]);
    const elapsedTime = Date.now() - startTime;
    console.log(`✅ Successfully registered in Firestore (took ${elapsedTime}ms)`);
  } catch (err) {
    console.error('❌ ERROR registering in Firestore:', err.message || err);
    console.error('❌ Full error:', err);
    isJoiningRoom = false; // Reset flag on error so user can retry
    alert('Failed to join room: ' + (err.message || 'Firebase error'));
    throw err;
  }

  console.log('Setting up peer listener...');
  console.log('📝 Creating onSnapshot listener for peers collection...');
  
  // Set up a diagnostic timer to detect if peer listener is hanging
  const diagnosticTimer = setTimeout(() => {
    console.warn('⚠️ DIAGNOSTIC: Peer listener has not fired after 5 seconds');
    console.warn('⚠️ This may indicate Firebase connection issues');
    console.warn('⚠️ Check: Network connectivity, Firestore rules, API credentials');
  }, 5000);

  // Listen for other peers joining
  const listenerStartTime = Date.now();
  const unsubscribePeers = firestore.collection('rooms').doc(roomId).collection('peers').onSnapshot(
    async (snapshot) => {
      clearTimeout(diagnosticTimer); // Clear warning timer on first fire
      const listenerFireTime = Date.now() - listenerStartTime;
      console.log(`✅ Peer listener fired after ${listenerFireTime}ms`);
      console.log(`📡 Peer collection changed - ${snapshot.docs.length} total peers`);
      
      for (const doc of snapshot.docChanges()) {
        const peerId = doc.doc.id;
        console.log(`  Event: ${doc.type.toUpperCase()} - Peer: ${peerId}`);
        
        if (peerId !== currentUserId && doc.type === 'added') {
          // New peer joined
          if (!peers.has(peerId)) {
            console.log(`  ✅ New peer detected: ${peerId} - Creating connection`);
            console.log(`     localStream status: ${localStream ? '✅ EXISTS' : '❌ NULL'}`);
            await createPeerConnection(peerId, true); // We initiate offer
          } else {
            console.log(`  ⚠️ Peer ${peerId} already has connection`);
            console.log(`  ℹ️ Peer ${peerId} already has connection`);
          }
        }

        if (doc.type === 'removed') {
          // Peer left
          console.log(`  👋 Peer leaving: ${peerId}`);
          removePeer(peerId);
        }
      }
      updateDebugDisplay();
    },
    (error) => {
      console.error('❌ ERROR in peer listener:', error.message || error);
      console.error('❌ Full error object:', error);
      console.error('❌ Error code:', error.code);
      console.error('⚠️ Peer listener subscription failed after', Date.now() - listenerStartTime, 'ms');
    }
  );
  
  console.log('📝 Listener subscription setup complete');
  console.log('✅ Room joined successfully');
  console.log('   Waiting for peer events...');
}

function removePeer(peerId) {
  console.log(`=== REMOVING PEER: ${peerId} ===`);
  if (peers.has(peerId)) {
    const { pc, unsubscribe } = peers.get(peerId);
    console.log(`  Closing PC for ${peerId}`);
    pc.close();
    if (unsubscribe) {
      console.log(`  Unsubscribing listeners for ${peerId}`);
      unsubscribe();
    }
    // Remove audio element
    const audioElement = document.getElementById(`audio-${peerId}`);
    if (audioElement) {
      audioElement.remove();
      console.log(`  🔇 Removed audio element for ${peerId}`);
    }
    peers.delete(peerId);
    console.log(`✅ Peer ${peerId} removed`);
    updateDebugDisplay();
  } else {
    console.log(`  ℹ️ Peer ${peerId} not found in peers map`);
  }
}

async function leaveRoom() {
  console.log('=== LEAVING ROOM ===');
  if (!currentRoomId || !currentUserId) {
    console.log('  Not in a room, skipping');
    return;
  }

  console.log(`Removing self (${currentUserId}) from room ${currentRoomId}`);
  // Remove self from peers collection
  try {
    await firestore.collection('rooms').doc(currentRoomId).collection('peers').doc(currentUserId).delete();
    console.log('✅ Removed from Firestore');
  } catch (err) {
    console.error('❌ Error leaving room:', err);
  }

  // Close all peer connections
  console.log(`Closing ${peers.size} peer connections`);
  peers.forEach((_, peerId) => removePeer(peerId));

  currentRoomId = null;
  currentUserId = null;
  isJoiningRoom = false; // Reset join flag
  updateDebugDisplay();
  console.log('✅ Room left');
}

// ============ EVENT HANDLERS ============

webcamButton.onclick = async () => {
  console.log('=== START AUDIO BUTTON CLICKED ===');
  console.log('Current state - localStream:', localStream ? 'EXISTS' : 'NULL');
  
  if (localStream) {
    console.log('Stopping existing stream...');
    // Stop existing stream
    localStream.getTracks().forEach((track) => {
      console.log(`  Stopping track: ${track.kind}`);
      track.stop();
    });
    localStream = null;
    webcamButton.textContent = 'Start Audio Input';
    callButton.disabled = true;  // Disable call button when audio stops
    console.log('✅ Audio stopped');
    updateDebugDisplay();
    return;
  }

  console.log('Starting audio capture...');
  // Get local audio stream with high-quality constraints
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

  try {
    console.log('Requesting microphone access...');
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log('✅ Local stream acquired');
    console.log(`   Audio tracks: ${localStream.getAudioTracks().length}`);
    
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      const settings = audioTrack.getSettings();
      console.log('   Settings:', {
        sampleRate: settings.sampleRate,
        channelCount: settings.channelCount,
        echoCancellation: settings.echoCancellation,
      });
    }

    // Play local audio
    const localAudio = document.getElementById('webcamVideo');
    if (localAudio) {
      localAudio.srcObject = localStream;
      console.log('   Local audio element connected');
    }

    // If already in a room, add stream to all peer connections
    if (currentRoomId) {
      console.log(`   Adding stream to ${peers.size} existing peer connections`);
      peers.forEach(({ pc }) => {
        localStream.getTracks().forEach((track) => {
          pc.addTrack(track, localStream);
        });
      });
    }

    webcamButton.textContent = 'Stop Audio Input';
    callButton.disabled = false;  // Enable call button when audio starts
    console.log('✅ Call button enabled - ready to join room');
    updateDebugDisplay();
  } catch (err) {
    console.error('❌ Error getting local stream:', err);
    console.error('   Error name:', err.name);
    console.error('   Error message:', err.message);
    alert('Cannot access microphone. Make sure:\n1. Using HTTPS\n2. Microphone permission granted\n3. No other app is using it');
  }
};

callButton.onclick = async () => {
  console.log('=== CALL BUTTON CLICKED ===');
  console.log('Current localStream:', localStream ? 'EXISTS' : 'NULL');
  console.log('Current roomId:', currentRoomId);
  
  // Run diagnostics before joining
  await logDiagnostics();
  
  // Prevent concurrent room joins
  if (isJoiningRoom) {
    console.warn('⏳ Join operation already in progress - ignoring duplicate click');
    return;
  }

  const roomId = callInput.value.trim();
  console.log('Entered Room ID:', roomId);
  
  if (!roomId) {
    console.error('ERROR: No room ID entered');
    alert('Enter a room ID');
    return;
  }

  if (!localStream) {
    console.error('ERROR: No local stream. Click "Start Audio Input" first');
    alert('Start audio first! Click "Start Audio Input" button');
    return;
  }

  isJoiningRoom = true;
  console.log('📝 About to call joinRoom()...');
  console.log('Joining room:', roomId);
  try {
    const startTime = Date.now();
    console.log('⏱️ Room join started at:', new Date(startTime).toISOString());
    await joinRoom(roomId);
    const duration = Date.now() - startTime;
    console.log('✅ Successfully joined room:', roomId);
    console.log('⏱️ Room join took:', duration, 'ms');
    
    callButton.disabled = true;
    callInput.disabled = true;
    hangupButton.disabled = false;
    console.log('UI updated - callButton disabled, hangupButton enabled');
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error('ERROR joining room:', err);
    console.error('⏱️ Failed after:', duration, 'ms');
    alert('Failed to join room: ' + err.message);
    isJoiningRoom = false;
  }
};

hangupButton.onclick = async () => {
  console.log('=== HANGUP BUTTON CLICKED ===');
  await leaveRoom();
  isJoiningRoom = false; // Reset join flag
  callButton.disabled = false;
  callInput.disabled = false;
  hangupButton.disabled = true;
  console.log('UI reset - callButton re-enabled');

  // Stop local stream
  if (localStream) {
    console.log('Stopping local stream...');
    localStream.getTracks().forEach((track) => {
      console.log(`  Stopping track: ${track.kind}`);
      track.stop();
    });
    localStream = null;
    webcamButton.textContent = 'Start Audio';
    console.log('✅ Local stream stopped');
  }
  updateDebugDisplay();
};

// ============ INITIALIZE ============

console.log('%c🎙️  WebRTC Multi-Peer Audio Conference Ready', 'font-size: 16px; font-weight: bold; color: #0f0;');
console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0f0;');
console.log('%cSystem Status:', 'color: #0f0; font-weight: bold;');
console.log('  ✅ Firebase initialized');
console.log('  ✅ STUN/TURN servers configured');
console.log('  ✅ Audio constraints: 48kHz stereo, no processing');
console.log('  ✅ Event listeners ready');
console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0f0;');
console.log('%cNext Steps:', 'color: #0f0; font-weight: bold;');
console.log('1. Click "Start Audio Input" button');
console.log('2. Enter a Room ID (e.g., "test-1")');
console.log('3. Click "Join/Create Room"');
console.log('4. Share Room ID with others to connect');
console.log('%c━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'color: #0f0;');
updateDebugDisplay();
