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

// Assign random soldiers to each player's 2 rows: p0 => rows 0..1, p1 => rows 4..5
function initializeBoardForPlayers(board) {
  // Player 0 positions
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: 0,
        item: randomItem(),
        revealed: false
      };
    }
  }
  // Player 1 positions
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

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // -----------------------------
  // Lobby
  // -----------------------------
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
        currentPlayerIndex: 0, // Player 0 moves first
        waitingForTieBreak: false,
        tieSoldierP0: null,
        tieSoldierP1: null,
        state: "setup" // "setup" => can reshuffle, "playing" => normal moves, "finished"
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

  // -----------------------------
  // Reshuffle
  // -----------------------------
  socket.on("requestReshuffle", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex < 0) return;
    const player = game.players[playerIndex];
    if (player.reshuffles <= 0) return;

    player.reshuffles--;

    // Re-randomize that player's 2 rows
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

  // -----------------------------
  // Player Ready
  // -----------------------------
  socket.on("playerReady", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex < 0) return;
    game.players[playerIndex].ready = true;

    // If both are ready, start playing
    if (game.players[0].ready && game.players[1].ready) {
      game.state = "playing";
    }
    io.to(gameId).emit("updateGame", game);
  });

  // -----------------------------
  // Handle Moves
  // -----------------------------
  socket.on("playerMove", ({ gameId, fromRow, fromCol, toRow, toCol }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "playing") return;
    if (game.waitingForTieBreak) return; // can't move in the middle of tie break

    const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex !== game.currentPlayerIndex) return;

    const board = game.board;
    const soldierCell = board[fromRow][fromCol];
    if (!soldierCell || soldierCell.owner !== playerIndex) return;

    // Check movement range
    if (Math.abs(toRow - fromRow) > 1 || Math.abs(toCol - fromCol) > 1) {
      console.log("Invalid move: 1 cell in any direction only.");
      return;
    }

    if (toRow < 0 || toRow > 5 || toCol < 0 || toCol > 6) {
      console.log("Out of bounds.");
      return;
    }

    const targetCell = board[toRow][toCol];
    // If it's friendly occupant => invalid
    if (targetCell && targetCell.owner === playerIndex) {
      console.log("Can't move onto a friendly soldier.");
      return;
    }

    // Move the soldier
    board[fromRow][fromCol] = null;

    if (!targetCell) {
      // Empty cell => just move
      board[toRow][toCol] = {
        owner: playerIndex,
        item: soldierCell.item,
        revealed: soldierCell.revealed
      };
      endTurn(game);
    } else {
      // Combat
      const enemyOwner = targetCell.owner;
      const result = compareItems(soldierCell.item, targetCell.item);
      // Reveal the occupant for sure
      // Winner's occupant will become revealed
      if (result === 0) {
        // tie => tie break
        game.waitingForTieBreak = true;
        // We'll store both soldier states
        // Attacker is p{playerIndex}, enemy is p{enemyOwner}
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

        // Mark board cell as "tie" occupant
        board[toRow][toCol] = { owner: null, item: "tie", revealed: true };
      } else {
        // There's a winner
        let winnerIndex, winnerItem;
        if (result === 1) {
          winnerIndex = playerIndex;
          winnerItem = soldierCell.item;
        } else {
          winnerIndex = enemyOwner;
          winnerItem = targetCell.item;
        }
        // Place winner occupant, revealed
        board[toRow][toCol] = {
          owner: winnerIndex,
          item: winnerItem,
          revealed: true
        };
        endTurn(game);
      }
    }
    io.to(gameId).emit("updateGame", game);
  });

  function endTurn(game) {
    // Check if any player lost all soldiers
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

  // -----------------------------
  // Tie-Break re-pick
  // -----------------------------
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

    // If both picked
    if (game.tieSoldierP0.item && game.tieSoldierP1.item) {
      const result = compareItems(game.tieSoldierP0.item, game.tieSoldierP1.item);
      if (result === 0) {
        // tie again
        io.to(gameId).emit("tieAgain", game);
        // Clear items so they can pick again
        game.tieSoldierP0.item = null;
        game.tieSoldierP1.item = null;
      } else {
        // We have a winner
        const winnerIndex = (result === 1) ? 0 : 1;
        const loserIndex = 1 - winnerIndex;
        const winnerSoldier = (winnerIndex === 0 ? game.tieSoldierP0 : game.tieSoldierP1);
        const loserSoldier = (loserIndex === 0 ? game.tieSoldierP0 : game.tieSoldierP1);

        // Put winner occupant on the board
        game.board[winnerSoldier.row][winnerSoldier.col] = {
          owner: winnerIndex,
          item: winnerSoldier.item,
          revealed: true
        };
        // loser is removed
        game.waitingForTieBreak = false;
        game.tieSoldierP0 = null;
        game.tieSoldierP1 = null;

        endTurn(game);
        io.to(gameId).emit("updateGame", game);
      }
    } else {
      // One soldier still hasn't picked
      io.to(gameId).emit("updateGame", game);
    }
  });

  // -----------------------------
  // Disconnect
  // -----------------------------
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    const user = lobbyUsers.get(socket.id);
    if (!user) return;

    user.inGame = false;
    // If they were in a game, mark that game as finished by forfeit
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
        } else {
          game.winner = "abandoned";
        }
        io.to(gameId).emit("updateGame", game);
      }
    }

    lobbyUsers.delete(socket.id);
    updateLobby();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
