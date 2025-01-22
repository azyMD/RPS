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

// Initialize a new board for the 2 human players
function initializeBoardForPlayers(board) {
  // Player 0 => rows 0..1
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
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
        owner: 1,
        item: randomItem(),
        revealed: false
      };
    }
  }
}

// Initialize a new board for "Play with Bot"
function initializeBoardWithBot(board) {
  // We treat "bot" as player1 => rows 4..5
  // The human is player0 => rows 0..1
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: 0, // human
        item: randomItem(),
        revealed: false
      };
    }
  }
  for (let r = 4; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      board[r][c] = {
        owner: 1, // bot
        item: randomItem(),
        revealed: false
      };
    }
  }
}

// Randomly move a single "bot" soldier
function botMakeMove(game) {
  // The bot is playerIndex=1
  // We'll pick all possible moves for the bot, then pick one at random
  const moves = getAllPossibleMoves(game, 1);
  if (moves.length === 0) return; // no move possible
  const choice = moves[Math.floor(Math.random() * moves.length)];
  // Perform the move
  // This re-uses the same logic as "playerMove," but we can do it inline:
  const board = game.board;
  const fromCell = board[choice.fromRow][choice.fromCol];
  board[choice.fromRow][choice.fromCol] = null;
  const targetCell = board[choice.toRow][choice.toCol];

  if (!targetCell) {
    // empty cell
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
      // tie -> tie break
      // We'll do an automatic tie break for the bot (random again).
      game.waitingForTieBreak = true;
      // attacker is p1, defender is occupant
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
        // p1's soldier wins
        winnerIndex = 1;
        winnerItem = fromCell.item;
      } else {
        // occupant wins
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

// Collect all valid moves for a given playerIndex
function getAllPossibleMoves(game, playerIndex) {
  const board = game.board;
  const moves = [];
  // For each soldier of that player, see which cells they can move to
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const cell = board[r][c];
      if (cell && cell.owner === playerIndex) {
        // check up to 8 directions
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue; // skip no-move
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < 6 && nc >= 0 && nc < 7) {
              const target = board[nr][nc];
              // can't move onto friendly soldier
              if (!target || target.owner !== playerIndex) {
                moves.push({
                  fromRow: r,
                  fromCol: c,
                  toRow: nr,
                  toCol: nc
                });
              }
            }
          }
        }
      }
    }
  }
  return moves;
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

  // Challenge another user (2-player)
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
        state: "setup",
        winner: null,
        isBotGame: false // Distinguish from bot game
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
  // Play with Bot
  // -----------------------------
  socket.on("playWithBot", () => {
    const user = lobbyUsers.get(socket.id);
    if (!user || user.inGame) return;

    const gameId = generateGameId();
    const board = createEmptyBoard();
    initializeBoardWithBot(board); // place p0=human, p1=bot

    const gameState = {
      gameId,
      board,
      players: [
        { socketId: socket.id, username: user.username, reshuffles: 3, ready: false },
        { socketId: "BOT", username: "Bot", reshuffles: 3, ready: true }
      ],
      currentPlayerIndex: 0, // Human goes first
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
    // Start
    io.to(socket.id).emit("startGame", gameState);
    updateLobby();
  });

  // -----------------------------
  // Reshuffle
  // -----------------------------
  socket.on("requestReshuffle", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "setup") return;

    // If it's a bot game, only player0 can shuffle (the bot is always "ready").
    const playerIndex = game.players.findIndex((p) => p.socketId === socket.id);
    if (playerIndex < 0) return;
    const player = game.players[playerIndex];
    if (player.reshuffles <= 0) return;

    player.reshuffles--;

    // Re-randomize that player's rows
    const rowsToShuffle = (playerIndex === 0) ? [0,1] : [4,5];
    // But if it's a bot game and I'm p0, the bot is p1 => that is [4,5]. So watch out:
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

    // If it's a bot game, the bot is automatically ready. Or if both players are ready in a 2p game:
    if (game.players.every(p => p.ready)) {
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
    if (game.waitingForTieBreak) return; // can't move in tie break

    const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
    if (playerIndex < 0) return;
    if (playerIndex !== game.currentPlayerIndex) return;

    const board = game.board;
    const soldierCell = board[fromRow][fromCol];
    if (!soldierCell || soldierCell.owner !== playerIndex) return;

    // Check 1-cell move
    if (Math.abs(toRow - fromRow) > 1 || Math.abs(toCol - fromCol) > 1) {
      console.log("Invalid move: 1 cell in any direction only.");
      return;
    }
    if (toRow < 0 || toRow > 5 || toCol < 0 || toCol > 6) {
      console.log("Out of bounds.");
      return;
    }

    // Friendly occupant check
    const targetCell = board[toRow][toCol];
    if (targetCell && targetCell.owner === playerIndex) {
      console.log("Can't move onto a friendly soldier.");
      return;
    }

    // Move
    board[fromRow][fromCol] = null;

    if (!targetCell) {
      // Empty cell
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
        // tie -> tie break
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
        // There's a winner
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

    // If it's a bot game, let the bot move if the game isn't done
    if (game.isBotGame && !game.waitingForTieBreak && game.state === "playing") {
      // If the human didn't lose just now
      if (!game.winner && game.currentPlayerIndex === 1) {
        // Bot turn
        botMakeMove(game);
        io.to(gameId).emit("updateGame", game);
      }
    }
  });

  function endTurn(game) {
    // Check if someone has 0 soldiers
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
        // we have a winner
        const winnerIndex = (result === 1) ? 0 : 1;
        const loserIndex = 1 - winnerIndex;
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

        // If it's a bot game and the bot lost/won in the tie break, see if game continues
        if (game.isBotGame && game.state === "playing" && !game.winner) {
          // If it’s now the bot’s turn
          if (game.currentPlayerIndex === 1) {
            botMakeMove(game);
            io.to(gameId).emit("updateGame", game);
          }
        }
      }
    } else {
      // One soldier still hasn't picked
      io.to(gameId).emit("updateGame", game);
    }
  });

  // -----------------------------
  // Replay
  // -----------------------------
  socket.on("requestReplay", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;
    if (game.state !== "finished") {
      // Only allow replay if game is done
      return;
    }

    // Reset everything
    const board = createEmptyBoard();
    if (game.isBotGame) {
      // re-init with bot
      initializeBoardWithBot(board);
    } else {
      initializeBoardForPlayers(board);
    }

    game.board = board;
    game.currentPlayerIndex = 0;
    game.waitingForTieBreak = false;
    game.tieSoldierP0 = null;
    game.tieSoldierP1 = null;
    game.state = "setup";  // Let's set it back to setup, so they can reshuffle if they want
    game.winner = null;

    // Reset each player's stats
    game.players.forEach((p, idx) => {
      p.reshuffles = 3;
      p.ready = (game.isBotGame && idx === 1) ? true : false; // bot is always ready
    });

    io.to(gameId).emit("updateGame", game);
  });

  // -----------------------------
  // Exit to Lobby
  // -----------------------------
  socket.on("exitToLobby", ({ gameId }) => {
    const game = ongoingGames.get(gameId);
    if (!game) return;

    // Mark user as not in game
    const user = lobbyUsers.get(socket.id);
    if (user) {
      user.inGame = false;
    }

    if (!game.isBotGame) {
      // 2-player game
      const other = game.players.find((p) => p.socketId !== socket.id);
      if (other && other.socketId !== "BOT") {
        const otherUser = lobbyUsers.get(other.socketId);
        if (otherUser) otherUser.inGame = false;
        // Let them know the game ended
        io.to(other.socketId).emit("updateGame", {
          ...game,
          state: "finished",
          winner: "abandoned"
        });
        io.sockets.sockets.get(other.socketId)?.leave(gameId);
      }
    }
    // Remove the game
    ongoingGames.delete(gameId);
    io.sockets.sockets.get(socket.id)?.leave(gameId);

    updateLobby();
    // Tell user they returned to lobby
    io.to(socket.id).emit("returnedToLobby");
  });

  // -----------------------------
  // Disconnect
  // -----------------------------
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    const user = lobbyUsers.get(socket.id);
    if (!user) return;

    user.inGame = false;
    lobbyUsers.delete(socket.id);

    // If they were in a game, mark that as forfeit
    const gameId = Array.from(ongoingGames.keys()).find((id) =>
      ongoingGames.get(id).players.some((p) => p.socketId === socket.id)
    );
    if (gameId) {
      const game = ongoingGames.get(gameId);
      if (game && game.state !== "finished") {
        game.state = "finished";
        const otherIndex = game.players.findIndex((p) => p.socketId !== socket.id);
        if (otherIndex >= 0) {
          game.winner = game.players[otherIndex].username + " (by forfeit)";
          const otherSocketId = game.players[otherIndex].socketId;
          // Let the other user know
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
