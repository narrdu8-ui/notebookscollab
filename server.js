const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Le lien sera fourni par Render de manière sécurisée
const MONGO_URI = process.env.MONGO_URI; 
const DB_NAME = "collab_db";

let db, dbUsers, dbNotebooks, dbCells, dbLogs;
// Données par défaut si la base est vide
let globalData = { users: [], notebooks: [], cells: [] };
let logsData = [];

app.use(express.static(__dirname));

// --- INITIALISATION DE MONGODB ---
async function initDB() {
    if (!MONGO_URI) {
        console.error("⚠️ ERREUR : La variable MONGO_URI n'est pas définie !");
        return;
    }

    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        console.log("✅ Connecté à MongoDB Atlas !");
        
        db = client.db(DB_NAME);
        dbUsers = db.collection('users');
        dbNotebooks = db.collection('notebooks');
        dbCells = db.collection('cells');
        dbLogs = db.collection('logs');

        // --- Migration automatique (si ancienne structure app_data existe) ---
        const oldDataColl = db.collection('app_data');
        const oldSavedData = await oldDataColl.findOne({ id: "main_state" });
        if (oldSavedData && oldSavedData.data) {
            console.log("🔄 Migration des anciennes données monolithiques vers les nouvelles collections...");
            if (oldSavedData.data.users?.length) await dbUsers.insertMany(oldSavedData.data.users);
            if (oldSavedData.data.notebooks?.length) await dbNotebooks.insertMany(oldSavedData.data.notebooks);
            if (oldSavedData.data.cells?.length) await dbCells.insertMany(oldSavedData.data.cells);
            await oldDataColl.deleteOne({ id: "main_state" });
            console.log("✅ Migration terminée avec succès !");
        }

        // --- Chargement optimisé depuis les collections séparées ---
        // Le .project({ _id: 0 }) empêche d'envoyer les IDs internes Mongo au frontend
        const users = await dbUsers.find().project({ _id: 0 }).toArray();
        const notebooks = await dbNotebooks.find().project({ _id: 0 }).toArray();
        const cells = await dbCells.find().project({ _id: 0 }).toArray();

        globalData = {
            users: users || [],
            notebooks: notebooks || [],
            cells: cells || []
        };
        console.log(`✅ Données chargées : ${globalData.users.length} users, ${globalData.notebooks.length} notebooks, ${globalData.cells.length} cellules.`);

        // Charger les logs et auto-purger ceux de + de 14 jours
        const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
        if (dbLogs) {
            await dbLogs.deleteMany({ timestamp: { $lt: twoWeeksAgo } });
            logsData = await dbLogs.find().project({ _id: 0 }).sort({ timestamp: -1 }).toArray();
            console.log(`✅ Logs chargés : ${logsData.length} entrées (purge auto > 14j effectuée).`);
        }
    } catch (err) {
        console.error("❌ Erreur de connexion MongoDB :", err);
    }
}
initDB();

// --- ROUTE API INITIALE ---
app.get('/api/data', (req, res) => {
    res.json(globalData);
});

app.get('/api/logs', (req, res) => {
    res.json(logsData);
});

// --- AUTO-PURGE DES LOGS TOUTES LES 6 HEURES ---
setInterval(async () => {
    const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
    logsData = logsData.filter(l => l.timestamp >= twoWeeksAgo);
    if (dbLogs) {
        try { await dbLogs.deleteMany({ timestamp: { $lt: twoWeeksAgo } }); } catch(e) {}
    }
}, 6 * 60 * 60 * 1000);

// --- GESTION DU TEMPS RÉEL ---
// Dictionary to track active users per notebook: { notebookId: [ { userId, username, color }, ... ] }
const activeNotebookUsers = {};

io.on('connection', (socket) => {
    console.log('Nouvel utilisateur connecté:', socket.id);

    // Join a notebook room
    socket.on('join_notebook', ({ notebookId, user }) => {
        if (socket.currentNotebook) {
            socket.leave(socket.currentNotebook);
            if (activeNotebookUsers[socket.currentNotebook]) {
                activeNotebookUsers[socket.currentNotebook] = activeNotebookUsers[socket.currentNotebook].filter(u => u.userId !== socket.userId);
                io.to(socket.currentNotebook).emit('active_users_update', activeNotebookUsers[socket.currentNotebook]);
            }
        }
        
        socket.currentNotebook = notebookId;
        socket.userId = user.uid;
        socket.userObj = { userId: user.uid, username: user.username, color: user.color || '#6366f1' };
        
        socket.join(notebookId);
        
        if (!activeNotebookUsers[notebookId]) activeNotebookUsers[notebookId] = [];
        // Remove if already exists to avoid duplicates
        activeNotebookUsers[notebookId] = activeNotebookUsers[notebookId].filter(u => u.userId !== user.uid);
        activeNotebookUsers[notebookId].push(socket.userObj);
        
        io.to(notebookId).emit('active_users_update', activeNotebookUsers[notebookId]);
    });

    socket.on('leave_notebook', () => {
        if (socket.currentNotebook) {
            socket.leave(socket.currentNotebook);
            if (activeNotebookUsers[socket.currentNotebook]) {
                activeNotebookUsers[socket.currentNotebook] = activeNotebookUsers[socket.currentNotebook].filter(u => u.userId !== socket.userId);
                io.to(socket.currentNotebook).emit('active_users_update', activeNotebookUsers[socket.currentNotebook]);
            }
            socket.currentNotebook = null;
        }
    });

    // SYNCHRONISATION GLOBALE (Pour les gros changements: undo/redo, import de fichier)
    socket.on('update_data', async (newData) => {
        globalData = newData; 
        socket.broadcast.emit('data_updated', globalData);
        
        // Sauvegarde globale de secours dans les collections séparées
        if (db) {
            try {
                // On remplace le contenu pour correspondre exactement au nouvel état global
                await dbUsers.deleteMany({});
                if (newData.users?.length) await dbUsers.insertMany(newData.users);

                await dbNotebooks.deleteMany({});
                if (newData.notebooks?.length) await dbNotebooks.insertMany(newData.notebooks);

                await dbCells.deleteMany({});
                if (newData.cells?.length) await dbCells.insertMany(newData.cells);
            } catch (err) {
                console.error("Erreur lors de la sauvegarde update_data :", err);
            }
        }
    });

    // --- NOUVEAU: ACTIONS GRANULAIRES (Évite les rollbacks) ---
    // Au lieu de tout écraser, on met à jour uniquement ce qui a changé
    socket.on('action', async (action) => {
        if (!globalData.cells) globalData.cells = [];
        if (!globalData.notebooks) globalData.notebooks = [];
        if (!globalData.users) globalData.users = [];

        try {
            switch(action.type) {
                case 'ADD_CELL':
                    globalData.cells.push(action.payload);
                    // On spread {...action.payload} pour que Mongo n'ajoute pas de _id à notre objet en mémoire
                    if (dbCells) await dbCells.insertOne({ ...action.payload });
                    break;
                case 'DELETE_CELL':
                    globalData.cells = globalData.cells.filter(c => c.id !== action.payload.cellId);
                    if (dbCells) await dbCells.deleteOne({ id: action.payload.cellId });
                    break;
                case 'UPDATE_CELL':
                    const cell = globalData.cells.find(c => c.id === action.payload.cellId);
                    if (cell) Object.assign(cell, action.payload.data);
                    if (dbCells) await dbCells.updateOne({ id: action.payload.cellId }, { $set: action.payload.data });
                    break;
                case 'UPDATE_CELLS':
                    const bulkOps = [];
                    action.payload.forEach(update => {
                        const c = globalData.cells.find(x => x.id === update.cellId);
                        if (c) Object.assign(c, update.data);
                        bulkOps.push({ updateOne: { filter: { id: update.cellId }, update: { $set: update.data } } });
                    });
                    if (dbCells && bulkOps.length) await dbCells.bulkWrite(bulkOps);
                    break;
                case 'ADD_NOTEBOOK':
                    globalData.notebooks.push(action.payload);
                    if (dbNotebooks) await dbNotebooks.insertOne({ ...action.payload });
                    break;
                case 'UPDATE_NOTEBOOK':
                    const nb = globalData.notebooks.find(n => n.id === action.payload.notebookId);
                    if (nb) Object.assign(nb, action.payload.data);
                    if (dbNotebooks) await dbNotebooks.updateOne({ id: action.payload.notebookId }, { $set: action.payload.data });
                    break;
                case 'DELETE_NOTEBOOK':
                    globalData.notebooks = globalData.notebooks.filter(n => n.id !== action.payload.notebookId);
                    globalData.cells = globalData.cells.filter(c => c.notebookId !== action.payload.notebookId);
                    if (dbNotebooks) await dbNotebooks.deleteOne({ id: action.payload.notebookId });
                    if (dbCells) await dbCells.deleteMany({ notebookId: action.payload.notebookId });
                    break;
                case 'DELETE_NOTEBOOKS':
                    const nIds = action.payload.notebookIds;
                    globalData.notebooks = globalData.notebooks.filter(n => !nIds.includes(n.id));
                    globalData.cells = globalData.cells.filter(c => !nIds.includes(c.notebookId));
                    if (dbNotebooks) await dbNotebooks.deleteMany({ id: { $in: nIds } });
                    if (dbCells) await dbCells.deleteMany({ notebookId: { $in: nIds } });
                    break;
                case 'ADD_USER':
                    globalData.users.push(action.payload);
                    if (dbUsers) await dbUsers.insertOne({ ...action.payload });
                    break;
                case 'UPDATE_USER':
                    const u = globalData.users.find(x => x.id === action.payload.userId);
                    if (u) Object.assign(u, action.payload.data);
                    if (dbUsers) await dbUsers.updateOne({ id: action.payload.userId }, { $set: action.payload.data });
                    break;
            }
        } catch(err) {
            console.error("Erreur DB sur action:", action.type, err);
        }
        
        // On relaie l'action aux autres
        // If it's a notebook specific action, we could broadcast only to the room, but for now we broadcast globally 
        // as per original design, or to the specific notebook room if we want to optimize. 
        socket.broadcast.emit('action_received', action);
    });

    // --- NOUVEAU: SYNCHRONISATION CHIRURGICALE DE MONACO ---
    // Transmet uniquement les lettres tapées pour ne pas faire sauter le curseur des autres !
    socket.on('cell_edit_operations', async ({ cellId, code, changes }) => {
        const cell = globalData.cells?.find(c => c.id === cellId);
        if (cell) cell.code = code; // Met à jour l'état serveur
        
        // Relaie les frappes chirurgicales
        if (socket.currentNotebook) {
            socket.to(socket.currentNotebook).emit('remote_cell_edits', { cellId, code, changes });
        } else {
            socket.broadcast.emit('remote_cell_edits', { cellId, code, changes });
        }
        
        // Sauvegarde granulaire de LA cellule uniquement
        if (dbCells) {
            try {
                await dbCells.updateOne({ id: cellId }, { $set: { code: code } });
            } catch (err) {
                console.error("Erreur save DB cell_edit:", err);
            }
        }
    });

    // Relais ultra-rapide pour les curseurs multijoueurs
    socket.on('cursor_moved', (cursorData) => {
        if (socket.currentNotebook) {
            socket.to(socket.currentNotebook).emit('cursor_updated', cursorData);
        } else {
            socket.broadcast.emit('cursor_updated', cursorData);
        }
    });

    socket.on('disconnect', () => {
        console.log('Utilisateur déconnecté:', socket.id);
        if (socket.currentNotebook) {
            if (activeNotebookUsers[socket.currentNotebook]) {
                activeNotebookUsers[socket.currentNotebook] = activeNotebookUsers[socket.currentNotebook].filter(u => u.userId !== socket.userId);
                io.to(socket.currentNotebook).emit('active_users_update', activeNotebookUsers[socket.currentNotebook]);
            }
        }
    });

    // --- LOGS ---
    socket.on('add_log', async (logEntry) => {
        logsData.unshift(logEntry);
        // Purge en mémoire si > 14 jours
        const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
        logsData = logsData.filter(l => l.timestamp >= twoWeeksAgo);
        if (dbLogs) {
            try { await dbLogs.insertOne({ ...logEntry }); } catch(e) { console.error('Erreur log DB:', e); }
        }
        io.emit('logs_updated', logsData);
    });

    socket.on('clear_logs', async () => {
        logsData = [];
        if (dbLogs) { try { await dbLogs.deleteMany({}); } catch(e) {} }
        io.emit('logs_updated', logsData);
    });

    socket.on('purge_logs_older_than', async ({ days }) => {
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        logsData = logsData.filter(l => l.timestamp >= cutoff);
        if (dbLogs) { try { await dbLogs.deleteMany({ timestamp: { $lt: cutoff } }); } catch(e) {} }
        io.emit('logs_updated', logsData);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Serveur temps réel démarré sur le port ${PORT}`);
});
