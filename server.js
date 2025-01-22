const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// Lobby: track users by socketId -> { username, inGame }
const lobbyUsers = new Map();

// Ongoing board games by gameId -> gameState
const ongoingGames = new Map();

// Generate a random game ID
function generateGameId() {
  return "game_" + Math.random().toString(36).substr(2, 8);
}

// Create the initial 7x6 board
// We'll store board[row][col] = { soldier: {...} or null }
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

// For each soldier, generate a random R/P/S
// This runs during initial board setup or a "reshuffle"
function assignSoldiersRandomly(soldierPositions) {
  return soldierPositions.map(pos => {
    return {
      row: pos.row,
      col: pos.col,
      item: randomItem(),
      revealed: false
    };
  });
}

// Checks if item1 beats item2
// returns 1 if item1 wins, 2 if item2 wins, 0 if tie
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

// 2 rows for player1 -> (row 0..1), 2 rows for player2 -> (row 4..5)
function initializeBoardForPlayers(board) {
  // Player 1 soldier positions
  const p1Positions = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 7; c++) {
      p1Positions.push({ row: r, col: c });
    }
  }

  // Player 2 soldier positions
  const p2Positions = [];
  for (let r = 4; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      p2Positions.push({ row: r, col: c });
    }
  }

  // Assign random items
  const p1Soldiers = assignSoldiersRandomly(p1Positions);
  const p2Soldiers = assignSoldiersRandomly(p2Positions);

  // Place them on the board
  p1Soldiers.forEach(soldier => {
    board[soldier.row][soldier.col] = {
      owner: 0, // playerIndex = 0 (first player)
      item: soldier.item,
      revealed: soldier.revealed
    };
  });
  p2Soldiers.forEach(soldier => {
    board[soldier.row][soldier.col] = {
      owner: 1, // second player
      item: soldier.item,
      revealed: soldier.revealed
    };
  });
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

    // Send challenge request
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
      // Create a new board game
      const gameId = generateGameId();

      // Build initial board
      const board = createEmptyBoard();
      initializeBoardForPlayers(board);

      const gameState = {
        gameId,
        board,
        players: [
          {
            socketId: from,
            username: challenger.username,
            reshuffles: 3,  // how many times they can reshuffle
            ready: false
          },
          {
            socketId: socket.id,
            username: responder.username,
            reshuffles: 3,
            ready: false
          }
        ],
        currentPlayerIndex: 0,  // player0 moves first (arbitrary)
        waitingForTieBreak: false, // used when we have a tie in combat
        tieSoldierP0: null,  // store soldier data to re-pick
        tieSoldierP1: null,  
        state: "setup" // "setup" = can reshuffle, "playing", "finished"
      };

      ongoingGames.set(gameId, gameState);

      // Mark them in-game
      challenger.inGame = true;
      responder.inGame = true;

      // Both join a Socket.IO room
      const fromSocket = io.sockets.sockets.get(from);
      const respSocket = io.sockets.sockets.get(socket.id);
      fromSocket?.join(gameId);
      respSocket?.join(gameId);

      // Send "startGame" to both
      io.to(gameId).emit("startGame", gameState);

      updateLobby();
    } else {
      // Declined
      io.to(from).emit("challengeDeclined", {
        reason: `${responder.username} declined your challenge.`
      });
    }
  });

  // -----------------------------
  // Handle Reshuffle
  // -----------------------------
  socket.on("requestReshuffle", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex < 0) return;

    const player = game.players[playerIndex];
    if (player.reshuffles <= 0) {
      console.log("No reshuffles left.");
      return;
    }
    player.reshuffles--;

    // Re-randomize that player's 2 rows
    const rowsToShuffle = (playerIndex === 0) ? [0,1] : [4,5];

    for (let r of rowsToShuffle) {
      for (let c = 0; c < 7; c++) {
        const cell = game.board[r][c];
        if (cell && cell.owner === playerIndex) {
          cell.item = randomItem();
          cell.revealed = false;
        }
      }
    }

    // Send updated state
    io.to(gameId).emit("updateGame", game);
  });

  // -----------------------------
  // Handle "ready" to start
  // -----------------------------
  socket.on("playerReady", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex < 0) return;
    game.players[playerIndex].ready = true;

    // Check if both players are ready
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
    if (game.waitingForTieBreak) {
      // can't move while tie break is in progress
      return;
    }

    const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex !== game.currentPlayerIndex) {
      console.log("Not your turn.");
      return;
    }

    // Validate move
    const board = game.board;
    const soldierCell = board[fromRow][fromCol];
    if (!soldierCell || soldierCell.owner !== playerIndex) {
      console.log("Invalid soldier or not your soldier.");
      return;
    }

    // Check movement range: 1 cell in any direction
    if (Math.abs(toRow - fromRow) > 1 || Math.abs(toCol - fromCol) > 1) {
      console.log("Invalid move: can only move 1 cell in any direction.");
      return;
    }
    if (toRow < 0 || toRow > 5 || toCol < 0 || toCol > 6) {
      console.log("Out of bounds.");
      return;
    }

    const targetCell = board[toRow][toCol];

    // If target is occupied by friendly soldier => can't move
    if (targetCell && targetCell.owner === playerIndex) {
      console.log("Can't move onto a friendly soldier.");
      return;
    }

    // Move soldier
    board[fromRow][fromCol] = null; // free old spot

    if (!targetCell) {
      // Just move into empty cell
      board[toRow][toCol] = {
        owner: playerIndex,
        item: soldierCell.item,
        revealed: soldierCell.revealed
      };
      endTurn(game);
    } else {
      // Combat scenario => targetCell is an enemy soldier
      const enemyOwner = targetCell.owner;
      const enemyItem = targetCell.item;
      const enemyRevealed = targetCell.revealed;

      // The attacker is soldierCell
      const attackerItem = soldierCell.item;
      const attackerRevealed = soldierCell.revealed;

      // Reveal both
      board[toRow][toCol] = {
        owner: playerIndex,
        item: attackerItem,
        revealed: true
      };
      // We'll check fight result
      const result = compareItems(attackerItem, enemyItem);
      if (result === 0) {
        // tie => must re-pick
        // We store a "tie break" state so neither can move until they re-pick
        game.waitingForTieBreak = true;
        // We store which soldier belongs to p0 and p1
        // The soldier that moved belongs to playerIndex
        game.tieSoldierP0 = {
          row: toRow,
          col: toCol,
          item: (playerIndex === 0) ? attackerItem : enemyItem,
          revealed: true
        };
        game.tieSoldierP1 = {
          row: toRow,
          col: toCol,
          item: (playerIndex === 1) ? attackerItem : enemyItem,
          revealed: true
        };

        // Actually, we need to clarify which cell is which soldier. Because they're in the same cell now.
        // Let's do a simpler approach:
        // We remove the enemy soldier from the board, but store it in tieSoldierP1 or p0. So effectively the cell is "shared" in the tie. 
        if (playerIndex === 0) {
          game.tieSoldierP0.row = toRow;
          game.tieSoldierP0.col = toCol;
          game.tieSoldierP0.item = attackerItem;
          game.tieSoldierP0.revealed = true;

          game.tieSoldierP1.row = toRow;
          game.tieSoldierP1.col = toCol;
          game.tieSoldierP1.item = enemyItem;
          game.tieSoldierP1.revealed = enemyRevealed || true;
        } else {
          // attacker is p1
          game.tieSoldierP1.row = toRow;
          game.tieSoldierP1.col = toCol;
          game.tieSoldierP1.item = attackerItem;
          game.tieSoldierP1.revealed = true;

          game.tieSoldierP0.row = toRow;
          game.tieSoldierP0.col = toCol;
          game.tieSoldierP0.item = enemyItem;
          game.tieSoldierP0.revealed = enemyRevealed || true;
        }

        // We'll mark the board cell with a placeholder to indicate "tie in progress."
        board[toRow][toCol] = {
          owner: null,
          item: "tie",
          revealed: true
        };

        io.to(gameId).emit("updateGame", game);
      } else {
        // We have a winner
        if (result === 1) {
          // attacker wins => stays in cell
          board[toRow][toCol] = {
            owner: playerIndex,
            item: attackerItem,
            revealed: true
          };
        } else {
          // enemy wins => revert cell to enemy soldier
          board[toRow][toCol] = {
            owner: enemyOwner,
            item: enemyItem,
            revealed: true
          };
        }
        endTurn(game);
      }
    }

    io.to(gameId).emit("updateGame", game);
  });

  function endTurn(game) {
    // check if one side lost all soldiers
    if (checkForWinner(game)) {
      game.state = "finished";
    } else {
      // switch turns
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
      // p1 wins
      game.winner = game.players[1].username;
      return true;
    }
    if (p1Count === 0) {
      // p0 wins
      game.winner = game.players[0].username;
      return true;
    }
    return false;
  }

  // -----------------------------
  // Handle tie-break re-picks
  // Each player picks a new item for the soldier that tied
  // We'll store them in memory, then compare
  // -----------------------------
  socket.on("tieBreakChoice", ({ gameId, newItem }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (!game.waitingForTieBreak) return;

    const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex < 0) return;

    if (playerIndex === 0) {
      game.tieSoldierP0.item = newItem;
    } else {
      game.tieSoldierP1.item = newItem;
    }

    // Check if both have chosen
    if (game.tieSoldierP0.item && game.tieSoldierP1.item) {
      // Compare again
      const result = compareItems(game.tieSoldierP0.item, game.tieSoldierP1.item);
      if (result === 0) {
        // tie again => reset the choice for next re-pick
        io.to(gameId).emit("tieAgain", game);
        // Each soldier still has that item, we can keep them or allow them to re-choose again
        // Let's remove the item so they pick again:
        // (Optional design: or keep the selected item until they pick a new one)
        game.tieSoldierP0.item = null;
        game.tieSoldierP1.item = null;
        return;
      } else {
        // We have a winner
        const winnerIndex = (result === 1) ? 0 : 1;
        const loserIndex = (winnerIndex === 0) ? 1 : 0;

        const winnerSoldier = game.tieSoldierP0;
        const loserSoldier = game.tieSoldierP1;
        if (winnerIndex === 1) {
          // swap
          winnerSoldier.item = game.tieSoldierP1.item;
          loserSoldier.item = game.tieSoldierP0.item;
        }

        // Put the winner soldier back on the board with revealed item
        game.board[winnerSoldier.row][winnerSoldier.col] = {
          owner: winnerIndex,
          item: winnerSoldier.item,
          revealed: true
        };
        // Loser is removed
        // waitingForTieBreak = false
        game.waitingForTieBreak = false;
        game.tieSoldierP0 = null;
        game.tieSoldierP1 = null;

        // End turn + check winner
        endTurn(game);
        // broadcast update
        io.to(gameId).emit("updateGame", game);
      }
    } else {
      // one player still hasn’t chosen
      io.to(gameId).emit("updateGame", game);
    }
  });

  // -----------------------------
  // Disconnect Handling
  // -----------------------------
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    const user = lobbyUsers.get(socket.id);
    if (!user) return;

    // If in a game, mark the game as abandoned
    user.inGame = false;

    const gameId = Array.from(ongoingGames.keys()).find((id) =>
      ongoingGames.get(id).players.some((p) => p.socketId === socket.id)
    );
    if (gameId) {
      const game = ongoingGames.get(gameId);
      if (game && game.state !== "finished") {
        // Mark winner as the other player
        const otherIndex = game.players.findIndex((p) => p.socketId !== socket.id);
        game.state = "finished";
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
