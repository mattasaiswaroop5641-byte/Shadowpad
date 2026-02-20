// Inject CryptoJS for Client-Side Encryption
if (!window.CryptoJS) {
    const script = document.createElement('script');
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js";
    document.head.appendChild(script);
}

const socket = io();

// Hide loading screen when connected
socket.on('connect', () => {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
});

// Element Selectors from your HTML
const authModule = document.getElementById('auth-module');
const appModule = document.getElementById('app-module');
const createForm = document.getElementById('create-form');
const joinForm = document.getElementById('join-form');
const editor = document.getElementById('main-editor');
const roomIdDisplay = document.getElementById('room-id-display');
const roomNameDisplay = document.querySelector('.room-name');
const userList = document.getElementById('user-list');
const userCountBadge = document.getElementById('user-count');
const userCounterText = document.getElementById('user-counter-text');
const activityList = document.getElementById('activity-list');
const leaveBtn = document.getElementById('leave-btn');
const permEdit = document.getElementById('perm-edit');
const permUpload = document.getElementById('perm-upload');
const permDelete = document.getElementById('perm-delete');
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const fileCountBadge = document.getElementById('file-count');

let currentRoomId = null;
let roomFiles = []; // Local cache for file content
let isPadMode = false;
let roomPassword = ''; // Store password for encryption

// --- Theme Initialization ---
const savedTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);

// --- Inject Settings Modal ---
function injectSettingsModal() {
    const modalHtml = `
    <div id="settings-modal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h3>Settings</h3>
                <button class="modal-close" id="close-settings">&times;</button>
            </div>
            <div class="input-group">
                <div class="permission-item">
                    <span>Light Mode</span>
                    <label>
                        <input type="checkbox" id="theme-toggle-switch">
                        <span class="toggle"></span>
                    </label>
                </div>
            </div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const themeSwitch = document.getElementById('theme-toggle-switch');
    const closeBtn = document.getElementById('close-settings');
    const modal = document.getElementById('settings-modal');

    // Set initial state
    themeSwitch.checked = document.documentElement.getAttribute('data-theme') === 'light';

    // Handle Toggle
    themeSwitch.addEventListener('change', (e) => {
        const next = e.target.checked ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
    });

    // Handle Close
    closeBtn.addEventListener('click', () => modal.classList.remove('active'));
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
    });
}
injectSettingsModal();

// --- Password Visibility Toggle ---
// Use event delegation to handle existing and dynamically injected forms
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('toggle-password')) {
        e.preventDefault();
        const btn = e.target;
        const input = btn.previousElementSibling;
        if (input && (input.type === 'password' || input.type === 'text')) {
            const isPass = input.type === 'password';
            input.type = isPass ? 'text' : 'password';
            btn.textContent = isPass ? '🙈' : '👁️';
        }
    }
});

// --- Inject Toolbar Icons (Save, Copy, Clear) ---
function setupToolbar() {
    const toolbar = document.querySelector('.editor-toolbar');
    if (!toolbar) return;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'nav-actions';
    
    const tools = [
        { icon: '💾', title: 'Save as Text', action: () => {
            const blob = new Blob([editor.value], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `shadowpad-${currentRoomId || 'doc'}.txt`;
            a.click();
        }},
        { icon: '🔗', title: 'Copy Room ID', action: () => {
            navigator.clipboard.writeText(currentRoomId).then(() => alert('Room ID copied!'));
        }},
        { icon: '⚙️', title: 'Settings', action: () => {
            document.getElementById('settings-modal').classList.add('active');
        }},
        { icon: '🧹', title: 'Clear Editor', action: () => {
            if(confirm('Clear all text?')) { editor.value = ''; editor.dispatchEvent(new Event('input')); }
        }}
    ];

    // Encrypted Exit Button (Hidden by default, shown in Pad Mode)
    const exitBtn = document.createElement('button');
    exitBtn.className = 'nav-btn';
    exitBtn.id = 'encrypted-exit-btn';
    exitBtn.innerHTML = '🔒';
    exitBtn.title = 'Sync & Destroy (Encrypted Exit)';
    exitBtn.style.display = 'none';
    exitBtn.style.color = '#fbbf24';
    exitBtn.onclick = handleEncryptedExit;
    actionsDiv.appendChild(exitBtn);

    // Delete Pad Button (Hidden by default, shown in Pad Mode)
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'nav-btn';
    deleteBtn.id = 'delete-pad-btn';
    deleteBtn.innerHTML = '🗑️';
    deleteBtn.title = 'Delete Pad Forever';
    deleteBtn.style.display = 'none';
    deleteBtn.style.color = '#ef4444';
    deleteBtn.onclick = handleDeletePad;
    actionsDiv.appendChild(deleteBtn);

    tools.forEach(t => {
        const btn = document.createElement('button');
        btn.className = 'nav-btn';
        btn.innerHTML = t.icon;
        btn.title = t.title;
        btn.onclick = t.action;
        actionsDiv.appendChild(btn);
    });
    
    // Insert before the existing permissions or append
    toolbar.appendChild(actionsDiv);
}
setupToolbar();

async function handleEncryptedExit() {
    if (!roomPassword) return alert("No encryption key found.");
    
    const btn = document.getElementById('encrypted-exit-btn');
    const originalContent = btn.innerHTML;
    btn.innerHTML = '⏳';
    btn.disabled = true;

    try {
        // 1. Encrypt data with the room password
        const encryptedData = CryptoJS.AES.encrypt(editor.value, roomPassword).toString();
        
        // 2. Send to backend (MongoDB) via API
        const response = await fetch('/api/save-pad', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId: currentRoomId, content: encryptedData })
        });

        if (!response.ok) throw new Error('Failed to save to database');

        // 3. Clear local state and leave
        alert("Data encrypted and saved to MongoDB. Leaving room...");
        window.location.reload();
    } catch (error) {
        console.error(error);
        alert("Error saving pad: " + error.message);
        btn.innerHTML = originalContent;
        btn.disabled = false;
    }
}

async function handleDeletePad() {
    if (!confirm("⚠️ PERMANENTLY DELETE this pad?\n\nThis will remove the encrypted data from the database. This action cannot be undone.")) return;

    try {
        const response = await fetch('/api/delete-pad', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId: currentRoomId })
        });

        if (!response.ok) throw new Error('Failed to delete pad');

        alert("Pad deleted from MongoDB.");
        window.location.reload();
    } catch (error) {
        console.error(error);
        alert("Error deleting pad: " + error.message);
    }
}

// Tab Switching Logic
document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));

        tab.classList.add('active');
        const targetForm = document.getElementById(`${tab.dataset.tab}-form`);
        if (targetForm) targetForm.classList.add('active');
    });
});

// --- Inject Style Switcher (Room vs Pad) ---
function injectStyleSwitcher() {
    const authCard = document.querySelector('.auth-card');
    const authTabs = document.querySelector('.auth-tabs');
    
    // 1. Inject Switcher UI
    const switcherHtml = `
        <div class="style-switcher">
            <button class="style-btn active" data-style="room">👥 Room Style</button>
            <button class="style-btn" data-style="pad">📝 Pad Style</button>
        </div>
    `;
    authCard.insertAdjacentHTML('afterbegin', switcherHtml);

    // 2. Inject Pad Mode Form
    const padFormHtml = `
        <form id="pad-form" class="auth-form">
            <div class="input-group">
                <label>Note Name / Room ID</label>
                <input type="text" id="pad-name" placeholder="e.g. my-secret-note" required>
            </div>
            <div class="input-group">
                <label>Password</label>
                <div class="password-wrapper">
                    <input type="password" id="pad-password" placeholder="Enter password" required>
                    <button type="button" class="toggle-password">👁️</button>
                </div>
            </div>
            <div class="input-group">
                <label style="display:flex; justify-content:space-between;">
                    <span>Max Users</span>
                    <span id="pad-max-users-val" style="color:var(--primary-color); font-weight:bold;">20</span>
                </label>
                <input type="range" id="pad-max-users" min="2" max="60" value="20" style="width:100%; margin-top:12px;">
            </div>
            <div class="pad-actions">
                <button type="submit" class="btn btn-primary" title="Join existing note">Open Note</button>
                <button type="button" class="btn" id="pad-create-btn" style="border:1px solid var(--border-color)" title="Create new note">Create New</button>
            </div>
        </form>
    `;
    authCard.insertAdjacentHTML('beforeend', padFormHtml);

    // 3. Switcher Logic
    const styleBtns = document.querySelectorAll('.style-btn');
    const padForm = document.getElementById('pad-form');
    
    // Pad Slider Logic
    const padSlider = document.getElementById('pad-max-users');
    const padDisplay = document.getElementById('pad-max-users-val');
    padSlider.addEventListener('input', (e) => padDisplay.textContent = e.target.value);

    styleBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const style = btn.dataset.style;
            styleBtns.forEach(b => b.classList.toggle('active', b === btn));
            
            if (style === 'room') {
                padForm.classList.remove('active');
                authTabs.style.display = 'flex';
                document.querySelector('.tab-btn.active').click(); // Restore active tab view
            } else {
                padForm.classList.add('active');
                authTabs.style.display = 'none';
                document.querySelectorAll('.auth-form').forEach(f => {
                    if(f.id !== 'pad-form') f.classList.remove('active');
                });
            }
        });
    });

    // 4. Pad Form Handlers
    padForm.addEventListener('submit', (e) => {
        e.preventDefault();
        isPadMode = true;
        roomPassword = document.getElementById('pad-password').value;
        socket.emit('join-room', { roomId: document.getElementById('pad-name').value.toUpperCase(), password: roomPassword, userName: 'Anonymous' });
    });

    document.getElementById('pad-create-btn').addEventListener('click', () => {
        if(padForm.checkValidity()) {
            isPadMode = true;
            roomPassword = document.getElementById('pad-password').value;
            socket.emit('create-room', { 
                roomName: document.getElementById('pad-name').value, 
                password: roomPassword, 
                userName: 'Anonymous',
                maxUsers: parseInt(document.getElementById('pad-max-users').value)
            });
        }
        else padForm.reportValidity();
    });
}
injectStyleSwitcher();

// Handle Creating a Room
createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    isPadMode = false;
    const roomName = document.getElementById('room-name').value;
    const userName = document.getElementById('owner-name').value;
    const password = roomPassword = document.getElementById('create-password').value;
    const maxUsers = document.getElementById('room-max-users') ? parseInt(document.getElementById('room-max-users').value) : 20;
    socket.emit('create-room', { roomName, password, userName, maxUsers });
});

// Handle Joining a Room
joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    isPadMode = false;
    const roomId = document.getElementById('join-room-id').value.toUpperCase();
    const userName = document.getElementById('join-name').value;
    const password = roomPassword = document.getElementById('join-password').value;
    socket.emit('join-room', { roomId, password, userName });
});

// UI Transition Logic
function enterRoom(id, name, content, users, isHost, files) {
    currentRoomId = id;
    authModule.classList.remove('active');
    appModule.classList.add('active');

    if (isPadMode) {
        document.body.classList.add('pad-mode');
        document.getElementById('encrypted-exit-btn').style.display = 'inline-flex';
        document.getElementById('delete-pad-btn').style.display = 'inline-flex';
        
        // Add Lock Icon if not present
        if (!document.querySelector('.lock-status')) {
            const lock = document.createElement('span');
            lock.className = 'lock-status';
            lock.innerHTML = '🔒';
            lock.title = 'End-to-End Encrypted';
            roomNameDisplay.appendChild(lock);
        }

        // Decrypt Content
        if (content) {
            try {
                const bytes = CryptoJS.AES.decrypt(content, roomPassword);
                const originalText = bytes.toString(CryptoJS.enc.Utf8);
                if (originalText) content = originalText;
            } catch (e) {
                console.error("Decryption failed", e);
                content = "--- 🔒 ENCRYPTED DATA (WRONG PASSWORD?) ---";
            }
        }
    } else {
        document.body.classList.remove('pad-mode');
        document.getElementById('encrypted-exit-btn').style.display = 'none';
        document.getElementById('delete-pad-btn').style.display = 'none';
    }

    roomNameDisplay.innerText = name;
    roomIdDisplay.innerText = id;
    editor.value = content;
    
    // Handle Host Permissions
    if (isHost) {
        document.body.classList.add('is-host');
    } else {
        document.body.classList.remove('is-host');
    }
    
    updateUserList(users);
    updateFileList(files);
}

socket.on('room-created', (data) => enterRoom(data.roomId, data.roomName, "", data.users, data.isHost, data.files));
socket.on('joined-successfully', (data) => enterRoom(data.roomId, data.roomName, data.content, data.users, data.isHost, data.files));
socket.on('error-msg', (msg) => alert(msg));

// Handle Host Migration
socket.on('you-are-host', () => {
    document.body.classList.add('is-host');
    alert("You are now the host of this room.");
});

// Handle User List Updates
function updateUserList(users) {
    userList.innerHTML = ''; // Clear current list
    users.forEach(user => {
        const userInitial = user.name.charAt(0).toUpperCase();
        const li = document.createElement('li');
        li.className = 'user-item';
        
        const hostBadge = user.isHost ? '<span class="user-tag host" title="Host">👑</span>' : '';
        const youBadge = user.id === socket.id ? '<span class="user-tag">(You)</span>' : '';
        
        li.innerHTML = `
            <div class="user-avatar">${userInitial}</div>
            <span class="user-name">${user.name}</span>
            ${hostBadge}
            ${youBadge}
        `;
        userList.appendChild(li);
    });
    const count = users.length;
    userCountBadge.innerText = count;
    userCounterText.innerText = `${count}/60`;
}

socket.on('update-user-list', (users) => {
    updateUserList(users);
});

// Handle File Uploads
uploadZone.addEventListener('click', () => {
    if (!uploadZone.classList.contains('disabled')) fileInput.click();
});

uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!uploadZone.classList.contains('disabled')) {
        uploadZone.classList.add('active');
    }
});

uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('active');
});

uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('active');
    const files = e.dataTransfer.files;
    if (files.length) handleFiles(files);
});

fileInput.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files.length) handleFiles(files);
    e.target.value = ''; // Reset input
});

function handleFiles(files) {
    if (uploadZone.classList.contains('disabled') && !document.body.classList.contains('is-host')) {
        alert("File uploads are disabled by the host.");
        return;
    }
    for (const file of files) {
        if (file.size > 25 * 1024 * 1024) { // 25MB limit (matches server config)
            alert(`File "${file.name}" is too large (max 25MB).`);
            continue;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const fileData = { name: file.name, type: file.type, size: file.size, content: e.target.result };
            socket.emit('upload-file', { roomId: currentRoomId, file: fileData });
        };
        reader.readAsArrayBuffer(file);
    }
}

function updateFileList(files) {
    roomFiles = files; // Update local cache
    fileList.innerHTML = '';
    files.forEach(file => {
        const li = document.createElement('li');
        li.className = 'file-item';
        li.dataset.fileId = file.id;
        li.innerHTML = `
            <span class="file-icon">📄</span>
            <div class="file-info">
                <span class="file-name" title="${file.name}">${file.name}</span>
                <span class="file-size">${(file.size / 1024).toFixed(1)} KB</span>
            </div>
            <div class="file-actions">
                <button class="file-action-btn" data-action="download" title="Download">📥</button>
                <button class="file-action-btn danger" data-action="delete" title="Delete">🗑️</button>
            </div>
        `;
        fileList.appendChild(li);
    });
    fileCountBadge.innerText = files.length;
}

socket.on('update-file-list', (files) => {
    updateFileList(files);
});

// Handle Activity Log
socket.on('activity-log', (message) => {
    const li = document.createElement('li');
    li.textContent = message;
    activityList.prepend(li); // Add new activity to the top
});

// Handle Leaving the Room
leaveBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to leave the room?')) {
        window.location.reload(); // Simple way to leave: just reload the page
    }
});

// Handle Permissions
permEdit.addEventListener('change', () => {
    if (currentRoomId) {
        socket.emit('update-permissions', { 
            roomId: currentRoomId, 
            allowEdit: permEdit.checked 
        });
    }
});

socket.on('update-permissions', (data) => {
    // Update checkbox state visually for everyone (though only host can click it)
    permEdit.checked = data.allowEdit;
    if (data.allowUpload !== undefined) permUpload.checked = data.allowUpload;
    if (data.allowDelete !== undefined) permDelete.checked = data.allowDelete;
    
    // If I am not the host, enforce the permission
    if (!document.body.classList.contains('is-host')) {
        editor.disabled = !data.allowEdit;
        editor.placeholder = data.allowEdit ? "Start typing..." : "Editing disabled by host.";
        
        if (data.allowUpload) {
            uploadZone.classList.remove('disabled');
        } else {
            uploadZone.classList.add('disabled');
        }

        // Toggle delete buttons visibility based on permission
        if (data.allowDelete) {
            fileList.classList.remove('delete-disabled');
        } else {
            fileList.classList.add('delete-disabled');
        }
    }
});

// --- Update Upload Zone Text (10MB -> 25MB) ---
if (uploadZone) {
    const walker = document.createTreeWalker(uploadZone, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while (node = walker.nextNode()) {
        if (node.nodeValue.includes('10')) {
            node.nodeValue = node.nodeValue.replace('10', '25');
        }
    }
}

// --- Update Max Users Text (2-20 -> 2-60) ---
if (authModule) {
    const walker = document.createTreeWalker(authModule, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while (node = walker.nextNode()) {
        if (node.nodeValue.includes('2-20')) {
            node.nodeValue = node.nodeValue.replace('2-20', '2-60');
        }
    }
}

permUpload.addEventListener('change', () => {
    if (currentRoomId) {
        socket.emit('update-permissions', { 
            roomId: currentRoomId, 
            allowUpload: permUpload.checked 
        });
    }
});

permDelete.addEventListener('change', () => {
    if (currentRoomId) {
        socket.emit('update-permissions', { 
            roomId: currentRoomId, 
            allowDelete: permDelete.checked 
        });
    }
});

// Real-time Text Syncing
editor.addEventListener('input', () => {
    if (currentRoomId) {
        socket.emit('update-text', {
            roomId: currentRoomId,
            content: editor.value
        });
    }
});

socket.on('text-synced', (content) => {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = content;
    // Restore cursor position if focused to prevent it from jumping to the end
    if (document.activeElement === editor) {
        editor.setSelectionRange(start, end);
    }
});

// Handle File Actions (Download & Delete)
fileList.addEventListener('click', (e) => {
    if (e.target.matches('.file-action-btn[data-action="download"]')) {
        const fileItem = e.target.closest('.file-item');
        const fileId = fileItem.dataset.fileId;
        const fileToDownload = roomFiles.find(f => f.id === fileId);

        if (fileToDownload) {
            const blob = new Blob([fileToDownload.content], { type: fileToDownload.type });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileToDownload.name;
            a.click();
            URL.revokeObjectURL(url);
        }
    }

    if (e.target.matches('.file-action-btn[data-action="delete"]')) {
        const fileItem = e.target.closest('.file-item');
        const fileId = fileItem.dataset.fileId;
        if(confirm('Delete this file?')) {
            socket.emit('delete-file', { roomId: currentRoomId, fileId });
        }
    }
});