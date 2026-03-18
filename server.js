--- START OF FILE server.js ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const MONGO_URI = process.env.MONGO_URI; 
const DB_NAME = "collab_db";

let db, dataCollection;
let globalData = { users: [], notebooks: [], cells: [] };

app.use(express.static(__dirname));

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
        const savedData = await dataCollection.findOne({ id: "main_state" });
        if (savedData) {
            globalData = savedData.data;
        } else {
            await dataCollection.insertOne({ id: "main_state", data: globalData });
        }
    } catch (err) {
        console.error("❌ Erreur de connexion MongoDB :", err);
    }
}
initDB();

app.get('/api/data', (req, res) => {
    res.json(globalData);
});

io.on('connection', (socket) => {
    console.log('Nouvel utilisateur connecté:', socket.id);

    socket.on('update_data', async (newData) => {
        globalData = newData;
        socket.broadcast.emit('data_updated', globalData);
        if (dataCollection) {
            dataCollection.updateOne(
                { id: "main_state" },
                { $set: { data: globalData } }
            ).catch(err => console.error("Erreur de sauvegarde MongoDB", err));
        }
    });

    // NOUVEAU : Diffusion des curseurs/sélections
    socket.on('cursor_move', (cursorData) => {
        // On renvoie les infos (position, nom, couleur, cellule) aux autres
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
