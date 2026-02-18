const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 25 * 1024 * 1024 // Exact 25MB limit
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

io.on('connection', (socket) => {
    socket.on('create-room', (data) => {
        const roomId = Math.random().toString(36).substring(2, 10).toUpperCase();
        const hostUser = { id: socket.id, name: data.userName, isHost: true };
        
        rooms.set(roomId, {
            name: data.roomName,
            password: data.password,
            content: "",
            files: [],
            permissions: { allowEdit: true, allowUpload: true, allowDelete: false },
            hostId: socket.id, // Store the host ID
            users: [hostUser]
        });
        
        socket.join(roomId);
        socket.roomId = roomId; // Track room for disconnect
        socket.emit('room-created', { roomId, roomName: data.roomName, isHost: true, users: [hostUser], files: [] });
    });

    socket.on('join-room', (data) => {
        const room = rooms.get(data.roomId);
        if (room && room.password === data.password) {
            socket.join(data.roomId);
            socket.roomId = data.roomId;
            const userData = { id: socket.id, name: data.userName, isHost: false };
            room.users.push(userData);
            
            // Tell everyone in the room to update their user lists
            io.to(data.roomId).emit('update-user-list', room.users);
            
            socket.emit('joined-successfully', { 
                roomName: room.name, 
                content: room.content,
                roomId: data.roomId,
                isHost: false,
                users: room.users,
                files: room.files
            });
            
            // Send current permissions state to the new user
            socket.emit('update-permissions', room.permissions);
        } else {
            socket.emit('error-msg', 'Invalid Room ID or Password');
        }
    });

    socket.on('update-text', ({ roomId, content }) => {
        const room = rooms.get(roomId);
        // Only broadcast if the room exists
        if (room) {
            room.content = content;
            socket.to(roomId).emit('text-synced', content);
        }
    });

    socket.on('upload-file', ({ roomId, file }) => {
        const room = rooms.get(roomId);
        if (room) {
            if (!room.permissions.allowUpload && socket.id !== room.hostId) {
                socket.emit('error-msg', 'File uploads are disabled by the host.');
                return;
            }
            const fileId = Math.random().toString(36).substring(2, 10);
            const newFile = {
                id: fileId,
                name: file.name,
                type: file.type,
                size: file.size,
                content: file.content // ArrayBuffer
            };
            room.files.push(newFile);
            io.to(roomId).emit('update-file-list', room.files);
        }
    });

    socket.on('delete-file', ({ roomId, fileId }) => {
        const room = rooms.get(roomId);
        if (room) {
            if (!room.permissions.allowDelete && socket.id !== room.hostId) {
                socket.emit('error-msg', 'File deletion is disabled by the host.');
                return;
            }
            room.files = room.files.filter(f => f.id !== fileId);
            io.to(roomId).emit('update-file-list', room.files);
        }
    });

    socket.on('update-permissions', ({ roomId, allowEdit, allowUpload, allowDelete }) => {
        const room = rooms.get(roomId);
        if (room && socket.id === room.hostId) {
            if (allowEdit !== undefined) room.permissions.allowEdit = allowEdit;
            if (allowUpload !== undefined) room.permissions.allowUpload = allowUpload;
            if (allowDelete !== undefined) room.permissions.allowDelete = allowDelete;
            // Broadcast new permissions to everyone in the room
            io.to(roomId).emit('update-permissions', room.permissions);
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomId) {
            const room = rooms.get(socket.roomId);
            if (room) {
                room.users = room.users.filter(u => u.id !== socket.id);
                
                // Host Migration: If host left and others remain, assign new host
                if (socket.id === room.hostId && room.users.length > 0) {
                    const newHost = room.users[0];
                    newHost.isHost = true;
                    room.hostId = newHost.id;
                    // Notify the new host
                    io.to(newHost.id).emit('you-are-host');
                }

                io.to(socket.roomId).emit('update-user-list', room.users);
                
                // Optional: Clean up empty rooms
                if (room.users.length === 0) {
                    rooms.delete(socket.roomId);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ShadowPad running on http://localhost:${PORT}`));