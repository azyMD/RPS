const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the "public" folder
app.use(express.static(path.join(__dirname, "public")));

// Store lobby users: { socketId => { username, inGame } }
const lobbyUsers = new Map();

// Ongoing games: { gameId => gameState }
const ongoingGames = new Map();

// Generate random ID for new games
function generateGameId() {
  return "game_" + Math.random().toString(36).substr(2, 8);
}

// Create 6x7 board
function createEmptyBoard() {
  const rows = 6, cols = 7;
  const board = [];
  for (let r = 0; r < rows; r++) {
    board[r] = [];
    for (let c = 0; c < cols; c++) {
      board[r][c] = null;
    }
  }
  return board;
}

// Random R/P/S
function randomItem() {
  const items = ["rock", "paper", "scissors"];
  return items[Math.floor(Math.random() * items.length)];
}

// Compare RPS: 0= tie, 1= item1 wins, 2= item2 wins
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

// Initialize board for a 2‐player match
// Player0 => rows 0..1, Player1 => rows 4..5
function initializeBoardForPlayers(board) {
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: 0,
        item: randomItem(),
        revealed: false
      };
    }
  }
  for (let r = 4; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: 1,
        item: randomItem(),
        revealed: false
      };
    }
  }
}

// For a bot game, same concept except the second player is the bot
function initializeBoardWithBot(board) {
  // Rows 0..1 => player 0 (human)
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: 0,
        item: randomItem(),
        revealed: false
      };
    }
  }
  // Rows 4..5 => player 1 (bot)
  for (let r = 4; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: 1,
        item: randomItem(),
        revealed: false
      };
    }
  }
}

// Check if a player lost all soldiers => game end
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

// End the turn => check winner or switch
function endTurn(game) {
  if (checkForWinner(game)) {
    game.state = "finished";
  } else {
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % 2;
  }
}

// For the bot: gather all valid moves
function getAllMoves(game, playerIndex) {
  const board = game.board;
  const moves = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const cell = board[r][c];
      if (cell && cell.owner === playerIndex) {
        // can move up to 1 cell in all directions
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

// Pick random move for the bot
function botMakeMove(game) {
  const moves = getAllMoves(game, 1);
  if (moves.length === 0) return;
  const choice = moves[Math.floor(Math.random() * moves.length)];

  const board = game.board;
  const fromCell = board[choice.fromRow][choice.fromCol];
  board[choice.fromRow][choice.fromCol] = null;

  const targetCell = board[choice.toRow][choice.toCol];
  if (!targetCell) {
    // empty
    board[choice.toRow][choice.toCol] = {
      owner: 1,
      item: fromCell.item,
      revealed: fromCell.revealed
    };
    endTurn(game);
  } else {
    // combat
    const result = compareItems(fromCell.item, targetCell.item);
    if (result === 0) {
      // tie
      game.waitingForTieBreak = true;
      game.tieSoldierP1 = {
        row: choice.toRow,
        col: choice.toCol,
        item: fromCell.item,
        revealed: true
      };
      game.tieSoldierP0 = {
        row: choice.toRow,
        col: choice.toCol,
        item: targetCell.item,
        revealed: true
      };
      board[choice.toRow][choice.toCol] = { owner: null, item: "tie", revealed: true };
    } else {
      let winnerIndex, winnerItem;
      if (result === 1) {
        winnerIndex = 1;
        winnerItem = fromCell.item;
      } else {
        winnerIndex = targetCell.owner;
        winnerItem = targetCell.item;
      }
      board[choice.toRow][choice.toCol] = {
        owner: winnerIndex,
        item: winnerItem,
        revealed: true
      };
      endTurn(game);
    }
  }
}

// -----------------------------------
// Socket.IO
// -----------------------------------
const updateLobby = () => {
  const data = Array.from(lobbyUsers.entries()).map(([sid, val]) => ({
    socketId: sid,
    username: val.username,
    inGame: val.inGame
  }));
  io.emit("lobbyData", data);
};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinLobby", (username) => {
    lobbyUsers.set(socket.id, { username, inGame: false });
    updateLobby();
  });

  // Challenge
  socket.on("challengeUser", (oppId) => {
    const user = lobbyUsers.get(socket.id);
    const opp = lobbyUsers.get(oppId);
    if (!user || !opp) return;
    if (user.inGame || opp.inGame) return;
    io.to(oppId).emit("challengeRequest", {
      from: socket.id,
      fromUsername: user.username
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

  // Play with Bot
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

  // Reshuffle
  socket.on("requestReshuffle", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    const idx = game.players.findIndex(p => p.socketId === socket.id);
    if (idx < 0) return;
    const player = game.players[idx];
    if (player.reshuffles <= 0) return;

    player.reshuffles--;

    const rowsToShuffle = (idx === 0) ? [0,1] : [4,5];
    for (let r of rowsToShuffle) {
      for (let c = 0; c < 7; c++) {
        const cell = game.board[r][c];
        if (cell && cell.owner === idx) {
          cell.item = randomItem();
          cell.revealed = false;
        }
      }
    }

    io.to(gameId).emit("updateGame", game);
  });

  // Player Ready
  socket.on("playerReady", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    const idx = game.players.findIndex(p => p.socketId === socket.id);
    if (idx < 0) return;
    game.players[idx].ready = true;

    // If both ready or if it's a bot game => start
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

    const idx = game.players.findIndex(p => p.socketId === socket.id);
    if (idx < 0) return;
    if (idx !== game.currentPlayerIndex) return;

    const board = game.board;
    const soldier = board[fromRow][fromCol];
    if (!soldier || soldier.owner !== idx) return;

    // Check 1 cell range
    if (Math.abs(toRow - fromRow) > 1 || Math.abs(toCol - fromCol) > 1) return;
    if (toRow < 0 || toRow > 5 || toCol < 0 || toCol > 6) return;

    const target = board[toRow][toCol];
    if (target && target.owner === idx) return; // can't land on ally

    // Move
    board[fromRow][fromCol] = null;
    if (!target) {
      // empty
      board[toRow][toCol] = {
        owner: idx,
        item: soldier.item,
        revealed: soldier.revealed
      };
      endTurn(game);
    } else {
      // fight
      const res = compareItems(soldier.item, target.item);
      if (res === 0) {
        // tie => tie break
        game.waitingForTieBreak = true;
        if (idx === 0) {
          game.tieSoldierP0 = { row: toRow, col: toCol, item: soldier.item, revealed: true };
          game.tieSoldierP1 = { row: toRow, col: toCol, item: target.item, revealed: true };
        } else {
          game.tieSoldierP1 = { row: toRow, col: toCol, item: soldier.item, revealed: true };
          game.tieSoldierP0 = { row: toRow, col: toCol, item: target.item, revealed: true };
        }
        board[toRow][toCol] = { owner: null, item: "tie", revealed: true };
      } else {
        let winnerIndex, winnerItem;
        if (res === 1) {
          winnerIndex = idx;
          winnerItem = soldier.item;
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
    io.to(gameId).emit("updateGame", game);

    // If bot game => let bot move if still playing
    if (game.isBotGame && !game.waitingForTieBreak && game.state === "playing") {
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

    const idx = game.players.findIndex(p => p.socketId === socket.id);
    if (idx < 0) return;

    if (idx === 0) {
      game.tieSoldierP0.item = newItem;
    } else {
      game.tieSoldierP1.item = newItem;
    }

    if (game.tieSoldierP0.item && game.tieSoldierP1.item) {
      const result = compareItems(game.tieSoldierP0.item, game.tieSoldierP1.item);
      if (result === 0) {
        // tie again
        io.to(gameId).emit("tieAgain", game);
        game.tieSoldierP0.item = null;
        game.tieSoldierP1.item = null;
      } else {
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

        // if bot game
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
    game.players.forEach((pl, i) => {
      pl.reshuffles = 3;
      pl.ready = (game.isBotGame && i === 1) ? true : false;
    });

    io.to(gameId).emit("updateGame", game);
  });

  // Exit
  socket.on("exitToLobby", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;

    const user = lobbyUsers.get(socket.id);
    if (user) user.inGame = false;

    if (!game.isBotGame) {
      // 2p
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

    const gameId = Array.from(ongoingGames.keys()).find(id =>
      ongoingGames.get(id).players.some(p => p.socketId === socket.id)
    );
    if (gameId) {
      const game = ongoingGames.get(gameId);
      if (game && game.state !== "finished") {
        game.state = "finished";
        const otherIndex = game.players.findIndex(p => p.socketId !== socket.id);
        if (otherIndex >= 0) {
          game.winner = game.players[otherIndex].username + " (by forfeit)";
          const otherSid = game.players[otherIndex].socketId;
          if (otherSid !== "BOT") {
            const ouser = lobbyUsers.get(otherSid);
            if (ouser) ouser.inGame = false;
            io.to(otherSid).emit("updateGame", game);
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

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
