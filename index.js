const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { Server } = require('socket.io');
const { availableParallelism } = require('node:os');
const cluster = require('node:cluster');
const { createAdapter, setupPrimary } = require('@socket.io/cluster-adapter');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const SECRET_KEY = 'my_super_secret_key';

if (cluster.isPrimary) {
    const numCPUs = availableParallelism();
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork({ PORT: 5000 + i });
    }
    return setupPrimary();
}

async function main() {
    const app = express();
    const server = createServer(app);
    const io = new Server(server, {
        adapter: createAdapter()
    });

    app.use(express.json());
    app.use(cookieParser());

    app.post('/login', (req, res) => {
        const { username, password } = req.body;
        if (username === 'user' && password === 'password') {
            const token = jwt.sign({ username }, SECRET_KEY, { expiresIn: '1h' });
            res.cookie('token', token, { httpOnly: true });
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
    });

    app.post('/logout', (req, res) => {
        res.clearCookie('token');
        res.json({ success: true });
    });

    const authenticate = (req, res, next) => {
        const token = req.cookies.token;
        if (token) {
            jwt.verify(token, SECRET_KEY, (err, user) => {
                if (err) {
                    return res.status(403).json({ success: false, message: 'Failed to authenticate token' });
                }
                req.user = user;
                next();
            });
        } else {
            res.sendFile(join(__dirname, 'login.html'));
        }
    };

    app.get('/login', (req, res) => {
        res.sendFile(join(__dirname, 'login.html'));
    });

    app.use(authenticate);

    app.get('/', (req, res) => {
        res.redirect('/default');
    });

    app.get('/:channelName', (req, res) => {
        res.sendFile(join(__dirname, 'index.html'));
    });

    var socketChannels = {};
    var choices = {};
    var pseudos = {};
    var scores = {};
    var rounds = {};

    function joinChannel(socket, channelName) {
        const channel = io.sockets.adapter.rooms.get(channelName);
        const numClients = channel ? channel.size : 0;

        if (numClients >= 2) {
            socket.emit('channelFull', { channel: channelName });
            return;
        }

        socket.join(channelName);
        if (!socketChannels[socket.id]) {
            socketChannels[socket.id] = [];
        }
        socketChannels[socket.id].push(channelName);
        if (!scores[socket.id]) {
            scores[socket.id] = 0;
        }
        if (!rounds[channelName]) {
            rounds[channelName] = 0;
        }
        console.log(`Socket ${socket.id} joined channel ${channelName}`);
    }

    function leaveChannel(socket, channelName) {
        socket.leave(channelName);
        if (socketChannels[socket.id]) {
            let index = socketChannels[socket.id].indexOf(channelName);
            if (index !== -1) {
                socketChannels[socket.id].splice(index, 1);
            }
        }
        console.log(`Socket ${socket.id} left channel ${channelName}`);
    }

    function listChannels(socket) {
        if (socketChannels[socket.id]) {
            console.log(`Channels for socket ${socket.id}:`, socketChannels[socket.id]);
            return socketChannels[socket.id];
        } else {
            console.log(`No channels for socket ${socket.id}`);
            return [];
        }
    }

    function listAllChannels() {
        let allChannels = new Set();

        for (let id in socketChannels) {
            socketChannels[id].forEach(channel => {
                allChannels.add(channel);
            });
        }

        let allChannelsArray = Array.from(allChannels);
        console.log("All unique channels:", allChannelsArray);
        return allChannelsArray;
    }

    function determineWinner(choice1, choice2) {
        if (choice1 === choice2) return 'Égalité';
        if (choice1 === 'Pierre' && choice2 === 'Ciseaux') return 'Victoire';
        if (choice1 === 'Feuille' && (choice2 === 'Pierre' || choice2 === 'Puits')) return 'Victoire';
        if (choice1 === 'Ciseaux' && choice2 === 'Feuille') return 'Victoire';
        if (choice1 === 'Puits' && (choice2 === 'Ciseaux' || choice2 === 'Pierre')) return 'Victoire';
        return 'Défaite';
    }

    function playRound(channelName) {
        if (rounds[channelName] >= 10) {
            const channelSockets = Array.from(io.sockets.adapter.rooms.get(channelName) || []);
            const [player1, player2] = channelSockets;
            const finalScores = {
                score1: scores[player1],
                score2: scores[player2]
            };
            const resultMessage = finalScores.score1 > finalScores.score2
                ? `${pseudos[player1]} wins!`
                : finalScores.score1 < finalScores.score2
                ? `${pseudos[player2]} wins!`
                : "It's a draw!";
            io.to(player1).emit('gameOver', {
                message: `Game Over. Final Score: ${pseudos[player1]}: ${scores[player1]}, ${pseudos[player2]}: ${scores[player2]}`,
                resultMessage: resultMessage
            });
            io.to(player2).emit('gameOver', {
                message: `Game Over. Final Score: ${pseudos[player1]}: ${scores[player1]}, ${pseudos[player2]}: ${scores[player2]}`,
                resultMessage: resultMessage
            });
            return;
        }

        const channelSockets = Array.from(io.sockets.adapter.rooms.get(channelName) || []);
        if (channelSockets.length === 2) {
            const [player1, player2] = channelSockets;
            if (choices[player1] && choices[player2]) {
                const result1 = determineWinner(choices[player1], choices[player2]);
                const result2 = determineWinner(choices[player2], choices[player1]);
                if (result1 === 'Victoire') scores[player1]++;
                if (result2 === 'Victoire') scores[player2]++;
                io.to(player1).emit('result', {
                    result: result1,
                    choice: choices[player1],
                    opponentChoice: choices[player2],
                    opponentPseudo: pseudos[player2],
                    score: scores[player1],
                    opponentScore: scores[player2],
                    pseudo: pseudos[player1]
                });
                io.to(player2).emit('result', {
                    result: result2,
                    choice: choices[player2],
                    opponentChoice: choices[player1],
                    opponentPseudo: pseudos[player1],
                    score: scores[player2],
                    opponentScore: scores[player1],
                    pseudo: pseudos[player2]
                });
                delete choices[player1];
                delete choices[player2];
                rounds[channelName]++;
                setTimeout(() => playRound(channelName), 1000); // Attendre 1 seconde avant de commencer un nouveau tour
            }
        }
    }

    io.on('connection', (socket) => {
        const defaultChannel = 'default';
        joinChannel(socket, defaultChannel);

        socket.on('SCheckPseudo', (pseudo) => {
            const usedPseudos = Object.values(pseudos);

            if (!usedPseudos.includes(pseudo)) {
                pseudos[socket.id] = pseudo;
                socket.emit('CPseudoStatus', pseudo);
            } else {
                socket.emit('CPseudoStatus', 'error');
            }
        });

        socket.on('SJoin', (channelName) => {
            leaveChannel(socket, defaultChannel);
            joinChannel(socket, channelName);

            socket.on('disconnect', () => {
                console.log(`User left channel: ${channelName}`);
                leaveChannel(socket, channelName);
                delete pseudos[socket.id];
                delete scores[socket.id];
                if (io.sockets.adapter.rooms.get(channelName)?.size === 0) {
                    delete rounds[channelName];
                }
            });

            playRound(channelName); // Démarrer un nouveau tour quand un joueur rejoint
        });

        socket.on('SListChannels', () => {
            let channels = listAllChannels(socket);
            socket.emit('CListChannels', channels);
        });

        socket.on('SChat', (data) => {
            io.to(data.channel).emit('CChat', { msg: data.msg, id: socket.id, pseudo: data.pseudo });
        });

        socket.on('choice', (data) => {
            choices[socket.id] = data.choice;
            socket.broadcast.to(data.channel).emit('choice', { pseudo: data.pseudo });
            playRound(data.channel); // Vérifier si les deux joueurs ont joué
        });

        socket.on('restartGame', (data) => {
            const channelSockets = Array.from(io.sockets.adapter.rooms.get(data.channel) || []);
            const [player1, player2] = channelSockets;
            scores[player1] = 0;
            scores[player2] = 0;
            rounds[data.channel] = 0;
            io.to(data.channel).emit('gameRestarted');
            playRound(data.channel);
        });
    });

    const port = process.env.PORT || 5000;

    server.listen(port, () => {
        console.log('server running at http://localhost:' + port);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${port} is already in use, trying port ${port + 1}`);
            server.listen(port + 1);
        } else {
            throw err;
        }
    });
}

main();
