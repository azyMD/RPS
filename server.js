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

// Ongoing games: { gameId => gameState }
const ongoingGames = new Map();

// Generate a random game ID
function generateGameId() {
  return "game_" + Math.random().toString(36).substr(2, 8);
}

// Create an empty 7×6 RPS board
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

// Initialize the board with each player's soldiers in two rows
function initializeBoardForPlayers(board, player0Index = 0, player1Index = 1) {
  // Player0 => rows 0..1
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: player0Index,
        item: randomItem(),
        revealed: false
      };
    }
  }
  // Player1 => rows 4..5
  for (let r = 4; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: player1Index,
        item: randomItem(),
        revealed: false
      };
    }
  }
}

// Check if one player lost all soldiers => game over
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

/**
 * Naive Bot AI: picks a random soldier belonging to botIndex, tries random adjacent moves.
 * If no moves are valid, does nothing. This code is purely illustrative.
 */
function botMakeMove(game) {
  const botIndex = 1; // We assume player[1] is the BOT
  const board = game.board;

  // Collect all bot soldiers
  const botCells = [];
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      if (board[r][c] && board[r][c].owner === botIndex) {
        botCells.push({ row: r, col: c });
      }
    }
  }

  // Shuffle the soldiers array
  shuffle(botCells);

  // Attempt a random move
  const directions = [
    { dr: -1, dc: 0 },  { dr: 1, dc: 0 },
    { dr: 0, dc: -1 },  { dr: 0, dc: 1 },
    { dr: -1, dc: -1 }, { dr: -1, dc: 1 },
    { dr: 1, dc: -1 },  { dr: 1, dc: 1 }
  ];

  for (let soldier of botCells) {
    // Randomize directions
    shuffle(directions);

    for (let dir of directions) {
      const nr = soldier.row + dir.dr;
      const nc = soldier.col + dir.dc;
      if (isValidMove(board, botIndex, soldier.row, soldier.col, nr, nc)) {
        // Perform that move as if the bot is calling "playerMove"
        doPlayerMove(game, botIndex, soldier.row, soldier.col, nr, nc);
        return;
      }
    }
  }
}

// Utility to shuffle an array in place
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// Check if move is valid
function isValidMove(board, playerIndex, fromR, fromC, toR, toC) {
  if (toR < 0 || toR > 5 || toC < 0 || toC > 6) return false;
  if (Math.abs(toR - fromR) > 1 || Math.abs(toC - fromC) > 1) return false;

  const soldierCell = board[fromR][fromC];
  if (!soldierCell || soldierCell.owner !== playerIndex) return false;

  const targetCell = board[toR][toC];
  if (targetCell && targetCell.owner === playerIndex) return false; // can't move onto friendly soldier

  return true;
}

// Actually perform the move. This reuses the same logic as "playerMove" but in function form.
function doPlayerMove(game, playerIndex, fromRow, fromCol, toRow, toCol) {
  const board = game.board;
  const soldierCell = board[fromRow][fromCol];
  board[fromRow][fromCol] = null;

  const targetCell = board[toRow][toCol];
  if (!targetCell) {
    // Just move
    board[toRow][toCol] = {
      owner: playerIndex,
      item: soldierCell.item,
      revealed: soldierCell.revealed
    };
    endTurn(game);
  } else {
    // Combat
    const result = compareItems(soldierCell.item, targetCell.item);
    if (result === 0) {
      // tie => tie break
      game.waitingForTieBreak = true;
      // Store tie info
      if (playerIndex === 0) {
        game.tieSoldierP0 = { row: toRow, col: toCol, item: soldierCell.item, revealed: true };
        game.tieSoldierP1 = { row: toRow, col: toCol, item: targetCell.item, revealed: true };
      } else {
        game.tieSoldierP1 = { row: toRow, col: toCol, item: soldierCell.item, revealed: true };
        game.tieSoldierP0 = { row: toRow, col: toCol, item: targetCell.item, revealed: true };
      }
      board[toRow][toCol] = { owner: null, item: "tie", revealed: true };
    } else {
      // There's a winner
      let winnerIndex, winnerItem;
      if (result === 1) {
        winnerIndex = playerIndex;
        winnerItem = soldierCell.item;
      } else {
        winnerIndex = targetCell.owner;
        winnerItem = targetCell.item;
      }
      board[toRow][toCol] = { owner: winnerIndex, item: winnerItem, revealed: true };
      endTurn(game);
    }
  }
}

// End the turn, check for a winner, possibly pass turn to next player or bot
function endTurn(game) {
  if (checkForWinner(game)) {
    game.state = "finished";
  } else {
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % 2;
    // If it's a bot game and it's now the bot's turn, let the bot move
    if (game.isBotGame && game.currentPlayerIndex === 1 && !game.waitingForTieBreak && game.state !== "finished") {
      botMakeMove(game);
    }
  }
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // -----------------------
  // Join Lobby
  // -----------------------
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

  // -----------------------
  // Challenge Flow (2-Player)
  // -----------------------
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
      // Player0 => "from", Player1 => "socket.id"
      initializeBoardForPlayers(board, 0, 1);

      const gameState = {
        gameId,
        board,
        players: [
          { socketId: from, username: challenger.username, reshuffles: 3, ready: false },
          { socketId: socket.id, username: responder.username, reshuffles: 3, ready: false }
        ],
        currentPlayerIndex: 0, // Player0 moves first
        waitingForTieBreak: false,
        tieSoldierP0: null,
        tieSoldierP1: null,
        state: "setup",
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

  // -----------------------
  // Play with Bot
  // -----------------------
  socket.on("playWithBot", () => {
    const user = lobbyUsers.get(socket.id);
    if (!user || user.inGame) return;

    const gameId = generateGameId();
    const board = createEmptyBoard();
    // Player0 => the user, Player1 => the bot
    initializeBoardForPlayers(board, 0, 1);

    const gameState = {
      gameId,
      board,
      players: [
        { socketId: socket.id, username: user.username, reshuffles: 3, ready: false },
        { socketId: "BOT", username: "Bot", reshuffles: 3, ready: false }
      ],
      currentPlayerIndex: 0,
      waitingForTieBreak: false,
      tieSoldierP0: null,
      tieSoldierP1: null,
      state: "setup",
      isBotGame: true
    };

    ongoingGames.set(gameId, gameState);
    user.inGame = true;

    io.sockets.sockets.get(socket.id)?.join(gameId);
    io.to(socket.id).emit("startGame", gameState);
    updateLobby();
  });

  // -----------------------
  // Reshuffle
  // -----------------------
  socket.on("requestReshuffle", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex < 0) return;

    const player = game.players[playerIndex];
    if (player.reshuffles <= 0) return;

    player.reshuffles--;

    // Re‐randomize that player's 2 rows
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

  // -----------------------
  // Player Ready
  // -----------------------
  socket.on("playerReady", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex < 0) return;
    game.players[playerIndex].ready = true;

    // If both players (or user+bot) are ready, switch to "playing"
    // For the bot, we can just auto-ready the bot
    if (game.isBotGame) {
      // Bot is always "ready"
      game.players[1].ready = true;
    }

    // Check if everyone is ready
    if (game.players.every(p => p.ready)) {
      game.state = "playing";
    }

    io.to(gameId).emit("updateGame", game);
  });

  // -----------------------
  // Handle Moves
  // -----------------------
  socket.on("playerMove", ({ gameId, fromRow, fromCol, toRow, toCol }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "playing") return;
    if (game.waitingForTieBreak) return;

    const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex !== game.currentPlayerIndex) return;

    // Perform the move
    if (!isValidMove(game.board, playerIndex, fromRow, fromCol, toRow, toCol)) {
      console.log("Invalid move attempt");
      return;
    }

    doPlayerMove(game, playerIndex, fromRow, fromCol, toRow, toCol);
    io.to(gameId).emit("updateGame", game);
  });

  // -----------------------
  // Tie-Break re-pick
  // -----------------------
  socket.on("tieBreakChoice", ({ gameId, newItem }) => {
    const game = ongoingGames.get(gameId);
    if (!game || !game.waitingForTieBreak) return;

    const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex < 0) return;

    if (playerIndex === 0) {
      game.tieSoldierP0.item = newItem;
    } else {
      game.tieSoldierP1.item = newItem;
    }

    resolveTieBreak(game);
    io.to(gameId).emit("updateGame", game);
  });

  // If the bot is in tie break, we’ll handle it automatically in `resolveTieBreak` if needed
  function resolveTieBreak(game) {
    // If one soldier item is still null, wait for the other pick
    if (!game.tieSoldierP0.item || !game.tieSoldierP1.item) return;

    const result = compareItems(game.tieSoldierP0.item, game.tieSoldierP1.item);
    if (result === 0) {
      // tie again
      io.to(game.gameId).emit("tieAgain", game);
      game.tieSoldierP0.item = null;
      game.tieSoldierP1.item = null;

      // If the bot is one side, pick automatically
      pickTieForBotIfNeeded(game);
      return;
    }

    // We have a winner
    const winnerIndex = (result === 1) ? 0 : 1;
    const winnerSoldier = (winnerIndex === 0 ? game.tieSoldierP0 : game.tieSoldierP1);
    game.board[winnerSoldier.row][winnerSoldier.col] = {
      owner: winnerIndex,
      item: winnerSoldier.item,
      revealed: true
    };

    // Clear tie
    game.waitingForTieBreak = false;
    game.tieSoldierP0 = null;
    game.tieSoldierP1 = null;

    endTurn(game);
  }

  // Let the bot automatically pick a tie break item if it’s part of the tie
  function pickTieForBotIfNeeded(game) {
    if (!game.isBotGame) return;
    // If tieSoldierP0 or tieSoldierP1 belongs to the bot, pick a random item
    // The bot is always index=1
    if (game.tieSoldierP1 && !game.tieSoldierP1.item) {
      game.tieSoldierP1.item = randomItem();
    }
  }

  // -----------------------
  // Replay
  // -----------------------
  socket.on("requestReplay", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;

    // Reset the entire board
    game.board = createEmptyBoard();
    initializeBoardForPlayers(game.board); // Re-randomize
    game.state = "setup";
    game.currentPlayerIndex = 0;
    game.waitingForTieBreak = false;
    game.tieSoldierP0 = null;
    game.tieSoldierP1 = null;
    game.winner = null;

    // Reset each player's reshuffles & ready
    game.players.forEach((p) => {
      p.reshuffles = 3;
      p.ready = false;
    });

    io.to(gameId).emit("updateGame", game);
  });

  // -----------------------
  // Exit to Lobby
  // -----------------------
  socket.on("exitToLobby", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;

    // Mark this user as not in game
    const user = lobbyUsers.get(socket.id);
    if (user) {
      user.inGame = false;
    }

    if (game.isBotGame) {
      // Bot game => just remove the game
      ongoingGames.delete(gameId);
      io.sockets.sockets.get(socket.id)?.leave(gameId);
    } else {
      // It's a 2-player game
      const other = game.players.find((p) => p.socketId !== socket.id);
      if (other && other.socketId !== "BOT") {
        const otherUser = lobbyUsers.get(other.socketId);
        if (otherUser) otherUser.inGame = false;
        // Let them know the game ended
        io.to(other.socketId).emit("updateGame", {
          ...game,
          winner: "abandoned"
        });
        io.sockets.sockets.get(other.socketId)?.leave(gameId);
      }
      ongoingGames.delete(gameId);
      io.sockets.sockets.get(socket.id)?.leave(gameId);
    }

    updateLobby();

    // Send an event so client can switch UI
    io.to(socket.id).emit("returnedToLobby");
  });

  // -----------------------
  // Disconnect
  // -----------------------
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    const user = lobbyUsers.get(socket.id);
    if (!user) return;

    user.inGame = false;
    lobbyUsers.delete(socket.id);

    // If they were in a game
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
          // Mark the other user free
          const otherSocketId = game.players[otherIndex].socketId;
          const otherUser = lobbyUsers.get(otherSocketId);
          if (otherUser) otherUser.inGame = false;
          io.to(otherSocketId).emit("updateGame", game);
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
  console.log("Server running on port " + PORT);
});
