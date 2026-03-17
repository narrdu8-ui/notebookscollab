const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const DB_FILE = path.join(__dirname, 'db.json');

// Mémoire locale du serveur
let globalData = { users: [], notebooks: [], cells: [] };

// Au démarrage, on charge les données depuis db.json
if (fs.existsSync(DB_FILE)) {
    try {
        globalData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Erreur de lecture de db.json", e);
    }
}

// Dire à Express de servir les fichiers statiques (ton index.html)
app.use(express.static(__dirname));

// Route API pour le chargement initial quand un client se connecte
app.get('/api/data', (req, res) => {
    res.json(globalData);
});

// Gestion du Temps Réel avec Socket.io
io.on('connection', (socket) => {
    console.log('Nouvel utilisateur connecté:', socket.id);

    // Quand ce client fait une modification
    socket.on('update_data', (newData) => {
        globalData = newData; // Met à jour la RAM du serveur
        
        // Sauvegarde dans le fichier db.json (en arrière-plan)
        fs.writeFile(DB_FILE, JSON.stringify(globalData, null, 2), (err) => {
            if (err) console.error("Erreur d'écriture db.json", err);
        });

        // ⚡️ LA MAGIE : Diffuse la nouveauté à TOUS les autres clients ⚡️
        socket.broadcast.emit('data_updated', globalData);
    });

    socket.on('disconnect', () => {
        console.log('Utilisateur déconnecté:', socket.id);
    });
});

// Lancement du serveur (Render utilise process.env.PORT)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Serveur temps réel démarré sur le port ${PORT}`);
});