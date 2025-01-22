const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// Lobby: track { socketId => { username, inGame: false } }
const lobbyUsers = new Map();

// Ongoing board games: { gameId => gameState }
const ongoingGames = new Map();

// Generate random game ID
function generateGameId() {
  return "game_" + Math.random().toString(36).substr(2, 8);
}

// Generate random soldier ID
function generateSoldierId() {
  return "soldier_" + Math.random().toString(36).substr(2, 5);
}

// Create empty 7x6 board
function createEmptyBoard() {
  const rows = 6;
  const cols = 7;
  const board = [];
  for (let r = 0; r < rows; r++) {
    board[r] = [];
    for (let c = 0; c < cols; c++) {
      board[r][c] = null;
    }
  }
  return board;
}

// Return a random "rock"/"paper"/"scissors"
function randomItem() {
  const items = ["rock", "paper", "scissors"];
  return items[Math.floor(Math.random() * items.length)];
}

// Compare RPS items: return 1 if item1 wins, 2 if item2 wins, 0 if tie
function compareItems(item1, item2) {
  if (item1 === item2) return 0;
  if (
    (item1 === "rock" && item2 === "scissors") ||
    (item1 === "scissors" && item2 === "paper") ||
    (item1 === "paper" && item2 === "rock")
  ) {
    return 1;
  }
  return 2;
}

// Initialize board for two human players
function initializeBoardForPlayers(board) {
  // Player 0 => rows 0..1
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        soldierId: generateSoldierId(),
        owner: 0,
        item: randomItem(),
        revealed: false
      };
    }
  }
  // Player 1 => rows 4..5
  for (let r = 4; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        soldierId: generateSoldierId(),
        owner: 1,
        item: randomItem(),
        revealed: false
      };
    }
  }
}

// Initialize board for "bot" game
function initializeBoardWithBot(board) {
  // Player 0 => rows 0..1
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        soldierId: generateSoldierId(),
        owner: 0,
        item: randomItem(),
        revealed: false
      };
    }
  }
  // Bot => rows 4..5
  for (let r = 4; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        soldierId: generateSoldierId(),
        owner: 1,
        item: randomItem(),
        revealed: false
      };
    }
  }
}

// The rest of the logic is the same as our previous "board-based RPS with replay, exit, and bot" 
// except we must keep 'soldierId' intact whenever we move a soldier or do combat.

function botMakeMove(game) {
  // ...
  // (Implementation omitted here for brevity, but same as before)
  // Make sure to carry over soldierId when we do a move!
}

// etc...

// We'll provide the FULL updated server code below, including the new soldierId logic:

//------------------------------------------------------

function getAllPossibleMoves(game, playerIndex) {
  const board = game.board;
  const moves = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const cell = board[r][c];
      if (cell && cell.owner === playerIndex) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < 6 && nc >= 0 && nc < 7) {
              const target = board[nr][nc];
              if (!target || target.owner !== playerIndex) {
                moves.push({ fromRow: r, fromCol: c, toRow: nr, toCol: nc });
              }
            }
          }
        }
      }
    }
  }
  return moves;
}

function botMakeMove(game) {
  const moves = getAllPossibleMoves(game, 1);
  if (moves.length === 0) return;
  const choice = moves[Math.floor(Math.random() * moves.length)];

  const board = game.board;
  const fromCell = board[choice.fromRow][choice.fromCol];
  board[choice.fromRow][choice.fromCol] = null;
  const targetCell = board[choice.toRow][choice.toCol];

  if (!targetCell) {
    // empty
    board[choice.toRow][choice.toCol] = {
      soldierId: fromCell.soldierId,
      owner: 1,
      item: fromCell.item,
      revealed: fromCell.revealed
    };
    endTurn(game);
  } else {
    // fight
    const result = compareItems(fromCell.item, targetCell.item);
    if (result === 0) {
      game.waitingForTieBreak = true;
      // bot is p1
      game.tieSoldierP1 = {
        row: choice.toRow,
        col: choice.toCol,
        soldierId: fromCell.soldierId,
        item: fromCell.item,
        revealed: true
      };
      game.tieSoldierP0 = {
        row: choice.toRow,
        col: choice.toCol,
        soldierId: targetCell.soldierId,
        item: targetCell.item,
        revealed: true
      };
      board[choice.toRow][choice.toCol] = { owner: null, item: "tie", revealed: true };
    } else {
      let winnerIndex, winnerItem, winnerId;
      if (result === 1) {
        winnerIndex = 1;
        winnerItem = fromCell.item;
        winnerId = fromCell.soldierId;
      } else {
        winnerIndex = targetCell.owner;
        winnerItem = targetCell.item;
        winnerId = targetCell.soldierId;
      }
      board[choice.toRow][choice.toCol] = {
        soldierId: winnerId,
        owner: winnerIndex,
        item: winnerItem,
        revealed: true
      };
      endTurn(game);
    }
  }
}

function endTurn(game) {
  if (checkForWinner(game)) {
    game.state = "finished";
  } else {
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % 2;
  }
}

function checkForWinner(game) {
  const board = game.board;
  let p0Count = 0, p1Count = 0;
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const cell = board[r][c];
      if (cell) {
        if (cell.owner === 0) p0Count++;
        if (cell.owner === 1) p1Count++;
      }
    }
  }
  if (p0Count === 0) {
    game.winner = game.players[1].username;
    return true;
  }
  if (p1Count === 0) {
    game.winner = game.players[0].username;
    return true;
  }
  return false;
}

// Full socket.io logic with soldierId included in moves:
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinLobby", (username) => {
    lobbyUsers.set(socket.id, { username, inGame: false });
    updateLobby();
  });
  function updateLobby() {
    const usersList = Array.from(lobbyUsers.entries()).map(([sid, data]) => ({
      socketId: sid,
      username: data.username,
      inGame: data.inGame
    }));
    io.emit("lobbyData", usersList);
  }

  socket.on("challengeUser", (opponentSocketId) => {
    const challenger = lobbyUsers.get(socket.id);
    const opponent = lobbyUsers.get(opponentSocketId);
    if (!challenger || !opponent) return;
    if (challenger.inGame || opponent.inGame) return;
    io.to(opponentSocketId).emit("challengeRequest", {
      from: socket.id,
      fromUsername: challenger.username
    });
  });

  socket.on("challengeResponse", ({ from, accepted }) => {
    const challenger = lobbyUsers.get(from);
    const responder = lobbyUsers.get(socket.id);
    if (!challenger || !responder) return;

    if (accepted && !challenger.inGame && !responder.inGame) {
      const gameId = generateGameId();
      const board = createEmptyBoard();
      initializeBoardForPlayers(board);

      const gameState = {
        gameId,
        board,
        players: [
          { socketId: from, username: challenger.username, reshuffles: 3, ready: false },
          { socketId: socket.id, username: responder.username, reshuffles: 3, ready: false }
        ],
        currentPlayerIndex: 0,
        waitingForTieBreak: false,
        tieSoldierP0: null,
        tieSoldierP1: null,
        state: "setup",
        winner: null,
        isBotGame: false
      };

      ongoingGames.set(gameId, gameState);
      challenger.inGame = true;
      responder.inGame = true;

      io.sockets.sockets.get(from)?.join(gameId);
      io.sockets.sockets.get(socket.id)?.join(gameId);

      io.to(gameId).emit("startGame", gameState);
      updateLobby();
    } else {
      io.to(from).emit("challengeDeclined", {
        reason: `${responder.username} declined your challenge.`
      });
    }
  });

  // BOT
  socket.on("playWithBot", () => {
    const user = lobbyUsers.get(socket.id);
    if (!user || user.inGame) return;

    const gameId = generateGameId();
    const board = createEmptyBoard();
    initializeBoardWithBot(board);

    const gameState = {
      gameId,
      board,
      players: [
        { socketId: socket.id, username: user.username, reshuffles: 3, ready: false },
        { socketId: "BOT", username: "Bot", reshuffles: 3, ready: true }
      ],
      currentPlayerIndex: 0,
      waitingForTieBreak: false,
      tieSoldierP0: null,
      tieSoldierP1: null,
      state: "setup",
      winner: null,
      isBotGame: true
    };

    ongoingGames.set(gameId, gameState);
    user.inGame = true;

    io.sockets.sockets.get(socket.id)?.join(gameId);
    io.to(socket.id).emit("startGame", gameState);
    updateLobby();
  });

  socket.on("requestReshuffle", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex < 0) return;
    const player = game.players[playerIndex];
    if (player.reshuffles <= 0) return;

    player.reshuffles--;
    const rowsToShuffle = (playerIndex === 0) ? [0,1] : [4,5];
    rowsToShuffle.forEach(r => {
      for (let c = 0; c < 7; c++) {
        const cell = game.board[r][c];
        if (cell && cell.owner === playerIndex) {
          // Keep soldierId the same, just randomize item
          cell.item = randomItem();
          cell.revealed = false;
        }
      }
    });

    io.to(gameId).emit("updateGame", game);
  });

  socket.on("playerReady", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex < 0) return;
    game.players[playerIndex].ready = true;

    if (game.players.every(p => p.ready)) {
      game.state = "playing";
    }
    io.to(gameId).emit("updateGame", game);
  });

  // Player Move
  socket.on("playerMove", ({ gameId, fromRow, fromCol, toRow, toCol }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "playing") return;
    if (game.waitingForTieBreak) return;

    const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex < 0) return;
    if (playerIndex !== game.currentPlayerIndex) return;

    const board = game.board;
    const soldierCell = board[fromRow][fromCol];
    if (!soldierCell || soldierCell.owner !== playerIndex) return;

    if (Math.abs(toRow - fromRow) > 1 || Math.abs(toCol - fromCol) > 1) {
      return;
    }
    if (toRow < 0 || toRow > 5 || toCol < 0 || toCol > 6) {
      return;
    }
    const targetCell = board[toRow][toCol];
    if (targetCell && targetCell.owner === playerIndex) {
      return; // can't move onto friendly soldier
    }

    // Move soldier
    board[fromRow][fromCol] = null;
    if (!targetCell) {
      // empty
      board[toRow][toCol] = {
        soldierId: soldierCell.soldierId,
        owner: soldierCell.owner,
        item: soldierCell.item,
        revealed: soldierCell.revealed
      };
      endTurn(game);
    } else {
      // fight
      const result = compareItems(soldierCell.item, targetCell.item);
      if (result === 0) {
        game.waitingForTieBreak = true;
        if (playerIndex === 0) {
          game.tieSoldierP0 = {
            soldierId: soldierCell.soldierId,
            row: toRow,
            col: toCol,
            item: soldierCell.item,
            revealed: true
          };
          game.tieSoldierP1 = {
            soldierId: targetCell.soldierId,
            row: toRow,
            col: toCol,
            item: targetCell.item,
            revealed: true
          };
        } else {
          game.tieSoldierP1 = {
            soldierId: soldierCell.soldierId,
            row: toRow,
            col: toCol,
            item: soldierCell.item,
            revealed: true
          };
          game.tieSoldierP0 = {
            soldierId: targetCell.soldierId,
            row: toRow,
            col: toCol,
            item: targetCell.item,
            revealed: true
          };
        }
        board[toRow][toCol] = { owner: null, item: "tie", revealed: true };
      } else {
        let winnerIndex;
        let winnerItem;
        let winnerId;
        if (result === 1) {
          winnerIndex = soldierCell.owner;
          winnerItem = soldierCell.item;
          winnerId = soldierCell.soldierId;
        } else {
          winnerIndex = targetCell.owner;
          winnerItem = targetCell.item;
          winnerId = targetCell.soldierId;
        }
        board[toRow][toCol] = {
          soldierId: winnerId,
          owner: winnerIndex,
          item: winnerItem,
          revealed: true
        };
        endTurn(game);
      }
    }
    io.to(gameId).emit("updateGame", game);

    if (game.isBotGame && game.state === "playing" && !game.waitingForTieBreak) {
      if (game.currentPlayerIndex === 1 && !game.winner) {
        botMakeMove(game);
        io.to(gameId).emit("updateGame", game);
      }
    }
  });

  // Tie break
  socket.on("tieBreakChoice", ({ gameId, newItem }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (!game.waitingForTieBreak) return;

    const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex < 0) return;

    if (playerIndex === 0) {
      game.tieSoldierP0.item = newItem;
    } else {
      game.tieSoldierP1.item = newItem;
    }

    if (game.tieSoldierP0.item && game.tieSoldierP1.item) {
      const result = compareItems(game.tieSoldierP0.item, game.tieSoldierP1.item);
      if (result === 0) {
        io.to(gameId).emit("tieAgain", game);
        game.tieSoldierP0.item = null;
        game.tieSoldierP1.item = null;
      } else {
        const winnerIndex = (result === 1) ? 0 : 1;
        const winnerSoldier = (winnerIndex === 0 ? game.tieSoldierP0 : game.tieSoldierP1);

        game.board[winnerSoldier.row][winnerSoldier.col] = {
          soldierId: winnerSoldier.soldierId,
          owner: winnerIndex,
          item: winnerSoldier.item,
          revealed: true
        };
        game.waitingForTieBreak = false;
        game.tieSoldierP0 = null;
        game.tieSoldierP1 = null;
        endTurn(game);
        io.to(gameId).emit("updateGame", game);

        if (game.isBotGame && game.state === "playing" && game.currentPlayerIndex === 1 && !game.winner) {
          botMakeMove(game);
          io.to(gameId).emit("updateGame", game);
        }
      }
    } else {
      io.to(gameId).emit("updateGame", game);
    }
  });

  // Replay
  socket.on("requestReplay", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "finished") return;

    const board = createEmptyBoard();
    if (game.isBotGame) {
      initializeBoardWithBot(board);
    } else {
      initializeBoardForPlayers(board);
    }
    game.board = board;
    game.currentPlayerIndex = 0;
    game.waitingForTieBreak = false;
    game.tieSoldierP0 = null;
    game.tieSoldierP1 = null;
    game.state = "setup";
    game.winner = null;
    game.players.forEach((p, idx) => {
      p.reshuffles = 3;
      p.ready = (game.isBotGame && idx === 1) ? true : false;
    });

    io.to(gameId).emit("updateGame", game);
  });

  // Exit to Lobby
  socket.on("exitToLobby", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;

    const user = lobbyUsers.get(socket.id);
    if (user) user.inGame = false;

    if (!game.isBotGame) {
      const other = game.players.find(p => p.socketId !== socket.id);
      if (other && other.socketId !== "BOT") {
        const otherUser = lobbyUsers.get(other.socketId);
        if (otherUser) otherUser.inGame = false;
        io.to(other.socketId).emit("updateGame", {
          ...game,
          state: "finished",
          winner: "abandoned"
        });
        io.sockets.sockets.get(other.socketId)?.leave(gameId);
      }
    }
    ongoingGames.delete(gameId);
    io.sockets.sockets.get(socket.id)?.leave(gameId);

    updateLobby();
    io.to(socket.id).emit("returnedToLobby");
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    const user = lobbyUsers.get(socket.id);
    if (!user) return;
    user.inGame = false;
    lobbyUsers.delete(socket.id);

    const gameId = Array.from(ongoingGames.keys()).find((id) =>
      ongoingGames.get(id).players.some(p => p.socketId === socket.id)
    );
    if (gameId) {
      const game = ongoingGames.get(gameId);
      if (game && game.state !== "finished") {
        game.state = "finished";
        const otherIndex = game.players.findIndex(p => p.socketId !== socket.id);
        if (otherIndex >= 0) {
          game.winner = game.players[otherIndex].username + " (by forfeit)";
          const otherSocketId = game.players[otherIndex].socketId;
          if (otherSocketId !== "BOT") {
            const otherUser = lobbyUsers.get(otherSocketId);
            if (otherUser) otherUser.inGame = false;
            io.to(otherSocketId).emit("updateGame", game);
          }
        } else {
          game.winner = "abandoned";
        }
        ongoingGames.delete(gameId);
      }
    }
    updateLobby();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
