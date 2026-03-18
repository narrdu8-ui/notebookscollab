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

let db, dataCollection;
// Données par défaut si la base est vide
let globalData = { users: [], notebooks: [], cells: [] };

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
        dataCollection = db.collection('app_data');

        // On cherche le document principal qui contient tout le state
        const savedData = await dataCollection.findOne({ id: "main_state" });
        
        if (savedData) {
            globalData = savedData.data;
            console.log("Données chargées depuis MongoDB.");
        } else {
            // Premier lancement : on crée la structure de base
            await dataCollection.insertOne({ id: "main_state", data: globalData });
            console.log("Base de données initialisée.");
        }
    } catch (err) {
        console.error("❌ Erreur de connexion MongoDB :", err);
    }
}
initDB();

// --- SAUVEGARDE SILENCIEUSE ---
const saveToDB = () => {
    if (dataCollection) {
        dataCollection.updateOne(
            { id: "main_state" },
            { $set: { data: globalData } }
        ).catch(err => console.error("Erreur de sauvegarde MongoDB", err));
    }
};

// --- ROUTE API INITIALE ---
app.get('/api/data', (req, res) => {
    res.json(globalData);
});

// --- GESTION DU TEMPS RÉEL ---
io.on('connection', (socket) => {
    console.log('Nouvel utilisateur connecté:', socket.id);

    // SYNCHRONISATION GLOBALE (Pour les gros changements: undo/redo, import de fichier)
    socket.on('update_data', (newData) => {
        globalData = newData; 
        socket.broadcast.emit('data_updated', globalData);
        saveToDB();
    });

    // --- NOUVEAU: ACTIONS GRANULAIRES (Évite les rollbacks) ---
    // Au lieu de tout écraser, on met à jour uniquement ce qui a changé
    socket.on('action', (action) => {
        if (!globalData.cells) globalData.cells = [];
        if (!globalData.notebooks) globalData.notebooks = [];
        if (!globalData.users) globalData.users = [];

        switch(action.type) {
            case 'ADD_CELL':
                globalData.cells.push(action.payload);
                break;
            case 'DELETE_CELL':
                globalData.cells = globalData.cells.filter(c => c.id !== action.payload.cellId);
                break;
            case 'UPDATE_CELL':
                const cell = globalData.cells.find(c => c.id === action.payload.cellId);
                if (cell) Object.assign(cell, action.payload.data);
                break;
            case 'UPDATE_CELLS':
                action.payload.forEach(update => {
                    const c = globalData.cells.find(x => x.id === update.cellId);
                    if (c) Object.assign(c, update.data);
                });
                break;
            case 'ADD_NOTEBOOK':
                globalData.notebooks.push(action.payload);
                break;
            case 'UPDATE_NOTEBOOK':
                const nb = globalData.notebooks.find(n => n.id === action.payload.notebookId);
                if (nb) Object.assign(nb, action.payload.data);
                break;
            case 'DELETE_NOTEBOOK':
                globalData.notebooks = globalData.notebooks.filter(n => n.id !== action.payload.notebookId);
                globalData.cells = globalData.cells.filter(c => c.notebookId !== action.payload.notebookId);
                break;
            case 'ADD_USER':
                globalData.users.push(action.payload);
                break;
            case 'UPDATE_USER':
                const u = globalData.users.find(x => x.id === action.payload.userId);
                if (u) Object.assign(u, action.payload.data);
                break;
        }
        
        // On relaie l'action aux autres
        socket.broadcast.emit('action_received', action);
        saveToDB();
    });

    // --- NOUVEAU: SYNCHRONISATION CHIRURGICALE DE MONACO ---
    // Transmet uniquement les lettres tapées pour ne pas faire sauter le curseur des autres !
    socket.on('cell_edit_operations', ({ cellId, code, changes }) => {
        const cell = globalData.cells?.find(c => c.id === cellId);
        if (cell) cell.code = code; // Met à jour l'état serveur
        
        // Relaie les frappes chirurgicales
        socket.broadcast.emit('remote_cell_edits', { cellId, code, changes });
        saveToDB();
    });

    // Relais ultra-rapide pour les curseurs multijoueurs
    socket.on('cursor_moved', (cursorData) => {
        socket.broadcast.emit('cursor_updated', cursorData);
    });

    socket.on('disconnect', () => {
        console.log('Utilisateur déconnecté:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Serveur temps réel démarré sur le port ${PORT}`);
});
