const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

// Create Express + Socket.IO server
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from "public"
app.use(express.static(path.join(__dirname, "public")));

// Lobby data: Map<socketId, { username, inGame }>
const lobbyUsers = new Map();

// Ongoing games: Map<gameId, gameState>
const ongoingGames = new Map();

// ---------------------------------------
// Utility Functions
// ---------------------------------------

// Generate a random game ID (like "game_abc123")
function generateGameId() {
  return "game_" + Math.random().toString(36).substr(2, 8);
}

// Create an empty 6x7 board (rows=6, cols=7)
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

// Compare two RPS items. Return: 0 => tie, 1 => item1 wins, 2 => item2 wins
function compareItems(i1, i2) {
  if (i1 === i2) return 0;
  if (
    (i1 === "rock" && i2 === "scissors") ||
    (i1 === "scissors" && i2 === "paper") ||
    (i1 === "paper" && i2 === "rock")
  ) {
    return 1;
  }
  return 2;
}

// Place two human players' soldiers: 
// Player 0 in rows 0..1, Player 1 in rows 4..5
function initializeBoardForPlayers(board) {
  // Player 0 => top
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: 0,
        item: randomItem(),
        revealed: false,
      };
    }
  }
  // Player 1 => bottom
  for (let r = 4; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: 1,
        item: randomItem(),
        revealed: false,
      };
    }
  }
}

// Place human (0) in rows 0..1, Bot (1) in rows 4..5
function initializeBoardWithBot(board) {
  // Player 0 => rows 0..1
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: 0,
        item: randomItem(),
        revealed: false,
      };
    }
  }
  // Bot => rows 4..5
  for (let r = 4; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: 1,
        item: randomItem(),
        revealed: false,
      };
    }
  }
}

// Check if either player has 0 soldiers left => game over
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

// End a turn => check winner or switch current player
function endTurn(game) {
  if (checkForWinner(game)) {
    game.state = "finished";
  } else {
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % 2;
  }
}

// Return all possible moves for 'playerIndex'
function getAllPossibleMoves(game, playerIndex) {
  const board = game.board;
  const moves = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const cell = board[r][c];
      if (cell && cell.owner === playerIndex) {
        // can move 1 cell in any direction
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr;
            const nc = c + dc;
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

// Let the bot pick a random valid move
function botMakeMove(game) {
  const moves = getAllPossibleMoves(game, 1);
  if (moves.length === 0) return; // no moves => stuck
  const choice = moves[Math.floor(Math.random() * moves.length)];

  const { fromRow, fromCol, toRow, toCol } = choice;
  const board = game.board;
  const soldierCell = board[fromRow][fromCol];
  board[fromRow][fromCol] = null;

  const target = board[toRow][toCol];
  if (!target) {
    // empty
    board[toRow][toCol] = {
      owner: 1,
      item: soldierCell.item,
      revealed: soldierCell.revealed
    };
    endTurn(game);
  } else {
    // combat
    const result = compareItems(soldierCell.item, target.item);
    if (result === 0) {
      // tie
      game.waitingForTieBreak = true;
      // attacker is p1
      game.tieSoldierP1 = {
        row: toRow,
        col: toCol,
        item: soldierCell.item,
        revealed: true
      };
      game.tieSoldierP0 = {
        row: toRow,
        col: toCol,
        item: target.item,
        revealed: true
      };
      board[toRow][toCol] = { owner: null, item: "tie", revealed: true };
    } else {
      let winnerIndex;
      let winnerItem;
      if (result === 1) {
        winnerIndex = 1;
        winnerItem = soldierCell.item;
      } else {
        winnerIndex = target.owner;
        winnerItem = target.item;
      }
      board[toRow][toCol] = {
        owner: winnerIndex,
        item: winnerItem,
        revealed: true
      };
      endTurn(game);
    }
  }
}

// ---------------------------------------
// Socket.IO logic
// ---------------------------------------
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // 1) Lobby join
  socket.on("joinLobby", (username) => {
    lobbyUsers.set(socket.id, { username, inGame: false });
    updateLobby();
  });

  function updateLobby() {
    const data = Array.from(lobbyUsers.entries()).map(([sid, info]) => ({
      socketId: sid,
      username: info.username,
      inGame: info.inGame
    }));
    io.emit("lobbyData", data);
  }

  // 2) Challenge flow
  socket.on("challengeUser", (opponentId) => {
    const challenger = lobbyUsers.get(socket.id);
    const opponent = lobbyUsers.get(opponentId);
    if (!challenger || !opponent) return;
    if (challenger.inGame || opponent.inGame) return;
    io.to(opponentId).emit("challengeRequest", {
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

      // join room
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

  // 3) Play with Bot
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

  // 4) Reshuffle
  socket.on("requestReshuffle", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex < 0) return;
    const player = game.players[playerIndex];
    if (player.reshuffles <= 0) return;

    player.reshuffles--;

    // re-randomize that player's 2 rows
    const rowsToShuffle = (playerIndex === 0) ? [0,1] : [4,5];
    rowsToShuffle.forEach(r => {
      for (let c = 0; c < 7; c++) {
        const cell = game.board[r][c];
        if (cell && cell.owner === playerIndex) {
          cell.item = randomItem();
          cell.revealed = false;
        }
      }
    });

    io.to(gameId).emit("updateGame", game);
  });

  // 5) Player Ready
  socket.on("playerReady", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex < 0) return;
    game.players[playerIndex].ready = true;

    // If both (or if it's a bot game, the bot is always ready) => start
    if (game.players.every(p => p.ready)) {
      game.state = "playing";
    }
    io.to(gameId).emit("updateGame", game);
  });

  // 6) Player Move
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

    // Validate move range
    if (Math.abs(toRow - fromRow) > 1 || Math.abs(toCol - fromCol) > 1) {
      return;
    }
    if (toRow < 0 || toRow > 5 || toCol < 0 || toCol > 6) {
      return;
    }
    // Check occupant
    const targetCell = board[toRow][toCol];
    if (targetCell && targetCell.owner === playerIndex) {
      return; // can't move onto friendly soldier
    }

    // Move soldier
    board[fromRow][fromCol] = null;
    if (!targetCell) {
      // empty cell
      board[toRow][toCol] = {
        owner: playerIndex,
        item: soldierCell.item,
        revealed: soldierCell.revealed
      };
      endTurn(game);
    } else {
      // combat
      const result = compareItems(soldierCell.item, targetCell.item);
      if (result === 0) {
        // tie => tie break
        game.waitingForTieBreak = true;
        if (playerIndex === 0) {
          game.tieSoldierP0 = {
            row: toRow,
            col: toCol,
            item: soldierCell.item,
            revealed: true
          };
          game.tieSoldierP1 = {
            row: toRow,
            col: toCol,
            item: targetCell.item,
            revealed: true
          };
        } else {
          game.tieSoldierP1 = {
            row: toRow,
            col: toCol,
            item: soldierCell.item,
            revealed: true
          };
          game.tieSoldierP0 = {
            row: toRow,
            col: toCol,
            item: targetCell.item,
            revealed: true
          };
        }
        board[toRow][toCol] = { owner: null, item: "tie", revealed: true };
      } else {
        // a winner
        let winnerIndex;
        let winnerItem;
        if (result === 1) {
          winnerIndex = playerIndex;
          winnerItem = soldierCell.item;
        } else {
          winnerIndex = targetCell.owner;
          winnerItem = targetCell.item;
        }
        board[toRow][toCol] = {
          owner: winnerIndex,
          item: winnerItem,
          revealed: true
        };
        endTurn(game);
      }
    }
    io.to(gameId).emit("updateGame", game);

    // If bot game & still playing => let bot move
    if (game.isBotGame && !game.waitingForTieBreak && game.state === "playing") {
      if (game.currentPlayerIndex === 1 && !game.winner) {
        botMakeMove(game);
        io.to(gameId).emit("updateGame", game);
      }
    }
  });

  // 7) Tie break choice
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
      // compare again
      const result = compareItems(game.tieSoldierP0.item, game.tieSoldierP1.item);
      if (result === 0) {
        io.to(gameId).emit("tieAgain", game);
        game.tieSoldierP0.item = null;
        game.tieSoldierP1.item = null;
      } else {
        // winner
        const winnerIndex = (result === 1) ? 0 : 1;
        const winnerSoldier = (winnerIndex === 0 ? game.tieSoldierP0 : game.tieSoldierP1);
        game.board[winnerSoldier.row][winnerSoldier.col] = {
          owner: winnerIndex,
          item: winnerSoldier.item,
          revealed: true
        };
        game.waitingForTieBreak = false;
        game.tieSoldierP0 = null;
        game.tieSoldierP1 = null;
        endTurn(game);
        io.to(gameId).emit("updateGame", game);

        // bot might move after tie break if still playing
        if (game.isBotGame && game.state === "playing" && !game.winner) {
          if (game.currentPlayerIndex === 1) {
            botMakeMove(game);
            io.to(gameId).emit("updateGame", game);
          }
        }
      }
    } else {
      io.to(gameId).emit("updateGame", game);
    }
  });

  // 8) Replay
  socket.on("requestReplay", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "finished") return; // only allow if game ended

    // reset board to "setup"
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
      p.ready = (game.isBotGame && idx === 1) ? true : false; // bot is always ready
    });

    io.to(gameId).emit("updateGame", game);
  });

  // 9) Exit to Lobby
  socket.on("exitToLobby", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;

    const user = lobbyUsers.get(socket.id);
    if (user) user.inGame = false;

    if (!game.isBotGame) {
      // If 2-player, notify the other
      const other = game.players.find(p => p.socketId !== socket.id);
      if (other && other.socketId !== "BOT") {
        const otherUser = lobbyUsers.get(other.socketId);
        if (otherUser) otherUser.inGame = false;
        io.to(other.socketId).emit("updateGame", {
          ...game,
          state: "finished",
          winner: "abandoned",
        });
        io.sockets.sockets.get(other.socketId)?.leave(gameId);
      }
    }
    ongoingGames.delete(gameId);
    io.sockets.sockets.get(socket.id)?.leave(gameId);

    updateLobby();
    io.to(socket.id).emit("returnedToLobby");
  });

  // 10) Disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    const user = lobbyUsers.get(socket.id);
    if (!user) return;

    user.inGame = false;
    lobbyUsers.delete(socket.id);

    // if in a game => forfeit
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

// ---------------------------------------
// Start the server
// ---------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
