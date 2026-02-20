const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Global State
const rooms = {}; // In-memory state for active rooms
let isDbConnected = false; // Track DB connection status

// 1. MongoDB Connection
// Ensure you have MongoDB running locally or use a cloud URI
// 💡 TIP: Paste your MongoDB Atlas connection string below if running locally without a local DB
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://Admin:Mgsai1042@cluster0.iygxgom.mongodb.net/shadowpad?appName=Cluster0';

mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ MongoDB Connected');
        isDbConnected = true;
        
        // DEBUG: Print Database Stats on Startup
        console.log(`📂 Connected to Database: "${mongoose.connection.name}"`);
        
        // DIAGNOSTIC: List all databases and their sizes
        try {
            const adminDb = mongoose.connection.db.admin();
            const result = await adminDb.listDatabases();
            console.log("------------------------------------------------");
            console.log("📊 CLUSTER STORAGE BREAKDOWN:");
            result.databases.forEach(db => console.log(`   ➤ ${db.name}: ${(db.sizeOnDisk / 1024 / 1024).toFixed(2)} MB`));
            console.log("------------------------------------------------");
        } catch (e) { console.error("Error listing DBs:", e.message); }

        try {
            const count = await Pad.countDocuments();
            console.log(`📊 Found ${count} pads in the collection.`);
        } catch (e) { console.error("Error counting pads:", e); }
    })
    .catch(err => {
        console.error('❌ MongoDB Connection Error:', err.codeName || err.message);
        console.log('⚠️  Running in MEMORY-ONLY mode. Real-time features work, but data will NOT persist after restart.');
        isDbConnected = false;
    });

// 2. Define Pad Schema
const PadSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true },
    content: { type: String, default: "" }, // Stores the Encrypted Blob
    lastActive: { type: Date, default: Date.now, expires: 259200 } // Auto-delete if inactive for 3 days (3 * 24 * 60 * 60)
});
const Pad = mongoose.model('Pad', PadSchema);

// 3. Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // Crucial for parsing JSON body in POST requests

// 3.1 Health Check Route (For Uptime Monitors & Render)
app.get('/ping', (req, res) => res.status(200).send('pong'));

// 4. API Route: Save Encrypted Pad
app.post('/api/save-pad', async (req, res) => {
    try {
        if (!isDbConnected) {
            return res.status(503).json({ error: 'Database not connected. Data stored in memory only.' });
        }

        const { roomId, content } = req.body;
        
        if (!roomId || !content) {
            return res.status(400).json({ error: 'Room ID and Content are required' });
        }

        // Upsert: Update if exists, Insert if new
        await Pad.findOneAndUpdate(
            { roomId }, 
            { content, lastActive: Date.now() },
            { upsert: true, new: true }
        );

        console.log(`💾 Encrypted Pad saved: ${roomId}`);
        res.status(200).json({ success: true, message: 'Pad saved to MongoDB' });
    } catch (error) {
        console.error('Save failed:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// 4.1 API Route: Delete Pad
app.delete('/api/delete-pad', async (req, res) => {
    try {
        if (!isDbConnected) {
            return res.status(503).json({ error: 'Database not connected.' });
        }

        const { roomId, secret } = req.body;
        
        if (secret !== 'Mgsai1042') return res.status(403).json({ error: 'Unauthorized' });
        if (!roomId) return res.status(400).json({ error: 'Room ID required' });

        await Pad.findOneAndDelete({ roomId });
        
        // Disconnect all users in the deleted room
        if (rooms[roomId]) {
            rooms[roomId].users.forEach(u => {
                const socket = io.sockets.sockets.get(u.id);
                if (socket) socket.disconnect(true);
            });
            delete rooms[roomId]; // Clear from memory
        }

        console.log(`🗑️ Pad deleted: ${roomId}`);
        res.status(200).json({ success: true, message: 'Pad deleted' });
    } catch (error) {
        console.error('Delete failed:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// 4.2 API Route: Get All Pads (Admin Dashboard)
app.get('/api/pads', async (req, res) => {
    try {
        if (!isDbConnected) {
            return res.json([]); // Return empty list if no DB
        }

        // Simple security check (Use ?secret=Mgsai1042 in URL)
        if (req.query.secret !== 'Mgsai1042') {
            return res.status(403).json({ error: 'Unauthorized access' });
        }
        
        // Optimization: Use Aggregation to get size without fetching full content
        // This prevents the browser from crashing if you have 100MB+ of data
        const pads = await Pad.aggregate([
            { 
                $project: { 
                    roomId: { $ifNull: ["$roomId", "UNKNOWN_ID"] }, 
                    lastActive: { $ifNull: ["$lastActive", new Date(0)] }, 
                    size: { $cond: [{ $ifNull: ["$content", false] }, { $strLenCP: "$content" }, 0] } 
                } 
            },
            { $sort: { lastActive: -1 } },
            { $limit: 500 } // Optimization: Only load the last 500 active pads
        ]);
        res.json(pads);
    } catch (error) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 4.2.1 API Route: Bulk Cleanup (Delete Old Pads)
app.delete('/api/cleanup-pads', async (req, res) => {
    try {
        if (!isDbConnected) return res.status(503).json({ error: 'No DB' });
        
        const { secret, days } = req.body;
        if (secret !== 'Mgsai1042') return res.status(403).json({ error: 'Unauthorized' });
        
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - (days || 30)); // Default to 30 days
        
        const result = await Pad.deleteMany({ lastActive: { $lt: cutoff } });
        console.log(`🧹 Cleaned up ${result.deletedCount} old pads.`);
        
        res.json({ success: true, count: result.deletedCount, message: `Deleted ${result.deletedCount} pads older than ${days || 30} days.` });
    } catch (error) {
        console.error('Cleanup failed:', error);
        res.status(500).json({ error: 'Cleanup failed' });
    }
});

// 4.2.2 API Route: Drop Database (Nuclear Option)
app.delete('/api/drop-database', async (req, res) => {
    try {
        if (!isDbConnected) return res.status(503).json({ error: 'No DB' });
        const { secret } = req.body;
        if (secret !== 'Mgsai1042') return res.status(403).json({ error: 'Unauthorized' });

        await mongoose.connection.db.dropDatabase();
        console.log('💥 Database dropped successfully.');
        res.json({ success: true, message: 'Current database dropped. All data is gone.' });
    } catch (error) {
        res.status(500).json({ error: 'Drop failed' });
    }
});

// 4.3 API Route: Get Active Rooms & Users (Memory)
app.get('/api/active-rooms', (req, res) => {
    if (req.query.secret !== 'Mgsai1042') {
        return res.status(403).json({ error: 'Unauthorized access' });
    }
    // Convert rooms object to array
    const activeData = Object.values(rooms).map(r => ({
        roomId: r.id,
        users: r.users.map(u => ({ id: u.id, name: u.name, isHost: u.isHost }))
    }));
    res.json(activeData);
});

// 4.4 API Route: Kick (Ban) User
app.post('/api/kick-user', (req, res) => {
    const { socketId, secret } = req.body;
    if (secret !== 'Mgsai1042') return res.status(403).json({ error: 'Unauthorized' });

    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
        socket.emit('error-msg', 'You have been kicked by the admin.');
        socket.disconnect(true);
        res.json({ success: true, message: 'User kicked' });
    } else {
        res.status(404).json({ error: 'User not found or already disconnected' });
    }
});

// 5. Socket.IO Logic
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Create Room
    socket.on('create-room', ({ roomName, password, userName, maxUsers }) => {
        const roomId = roomName.toUpperCase();
        if (rooms[roomId]) {
            socket.emit('error-msg', 'Room already exists');
            return;
        }
        
        rooms[roomId] = {
            id: roomId,
            name: roomName,
            password, 
            users: [],
            files: [],
            content: '',
            hostId: socket.id,
            maxUsers: maxUsers || 20,
            permissions: { allowEdit: true, allowUpload: true, allowDelete: true }
        };
        
        joinRoomLogic(socket, roomId, userName, true);
    });

    // Join Room (Handles restoring from MongoDB)
    socket.on('join-room', async ({ roomId, password, userName }) => {
        let room = rooms[roomId];

        // If room not active, check MongoDB
        if (!room && isDbConnected) {
            // Find and update lastActive to reset the 3-day timer
            const savedPad = await Pad.findOneAndUpdate(
                { roomId },
                { lastActive: Date.now() },
                { new: true }
            );

            if (savedPad) {
                // Restore room from DB
                room = rooms[roomId] = {
                    id: roomId,
                    name: roomId,
                    password: password, // The password entered becomes the session key
                    users: [],
                    files: [],
                    content: savedPad.content, // Load encrypted content
                    hostId: socket.id,
                    maxUsers: 20,
                    permissions: { allowEdit: true, allowUpload: true, allowDelete: true }
                };
            }
        }

        if (!room) return socket.emit('error-msg', 'Room not found');
        if (room.password !== password) return socket.emit('error-msg', 'Incorrect password');
        if (room.users.length >= room.maxUsers) return socket.emit('error-msg', 'Room is full');

        joinRoomLogic(socket, roomId, userName, false);
    });

    // Sync Text
    socket.on('update-text', ({ roomId, content }) => {
        if (rooms[roomId]) {
            rooms[roomId].content = content;
            socket.to(roomId).emit('text-synced', content);
        }
    });

    // Helper: Join Logic
    function joinRoomLogic(socket, roomId, userName, isHost) {
        const room = rooms[roomId];
        const user = { id: socket.id, name: userName, isHost: isHost || socket.id === room.hostId };
        
        room.users.push(user);
        socket.join(roomId);

        socket.emit('joined-successfully', {
            roomId: room.id,
            roomName: room.name,
            content: room.content,
            users: room.users,
            isHost: user.isHost,
            files: room.files
        });
        
        io.to(roomId).emit('update-user-list', room.users);
        io.to(roomId).emit('activity-log', `${userName} joined.`);
    }

    // Handle Disconnect
    socket.on('disconnect', () => {
        Object.keys(rooms).forEach(roomId => {
            const room = rooms[roomId];
            const index = room.users.findIndex(u => u.id === socket.id);
            if (index !== -1) {
                const user = room.users[index];
                room.users.splice(index, 1);
                io.to(roomId).emit('update-user-list', room.users);
                io.to(roomId).emit('activity-log', `${user.name} left.`);
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Admin Panel: http://localhost:${PORT}/admin.html`);
});