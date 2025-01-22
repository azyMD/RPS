(() => {
  const socket = io();

  // DOM
  const loginContainer = document.getElementById("loginContainer");
  const usernameInput = document.getElementById("usernameInput");
  const joinBtn = document.getElementById("joinBtn");

  const lobbyContainer = document.getElementById("lobbyContainer");
  const usersList = document.getElementById("usersList");
  const playBotBtn = document.getElementById("playBotBtn");

  const gameContainer = document.getElementById("gameContainer");
  const gameStatus = document.getElementById("gameStatus");
  const reshuffleBtn = document.getElementById("reshuffleBtn");
  const readyBtn = document.getElementById("readyBtn");
  const turnInfo = document.getElementById("turnInfo");
  const boardElement = document.getElementById("board");
  const replayBtn = document.getElementById("replayBtn");
  const exitLobbyBtn = document.getElementById("exitLobbyBtn");

  const tieBreakModal = document.getElementById("tieBreakModal");
  const tieBtns = document.querySelectorAll(".tie-btn");
  const tieMessage = document.getElementById("tieMessage");

  // Local state
  let currentGame = null;
  let myPlayerIndex = null;  // 0 or 1
  let selectedCell = null;

  // ---------------------------
  // 1) Lobby / Login
  // ---------------------------
  joinBtn.addEventListener("click", () => {
    const username = usernameInput.value.trim();
    if (!username) {
      alert("Please enter a username!");
      return;
    }
    socket.emit("joinLobby", username);
    loginContainer.classList.add("hidden");
    lobbyContainer.classList.remove("hidden");
  });

  socket.on("lobbyData", (users) => {
    usersList.innerHTML = "";
    users.forEach((user) => {
      const li = document.createElement("li");
      let txt = user.username;
      if (user.inGame) txt += " (in-game)";
      li.textContent = txt;

      if (!user.inGame && user.socketId !== socket.id) {
        const challengeBtn = document.createElement("button");
        challengeBtn.textContent = "Challenge";
        challengeBtn.style.marginLeft = "10px";
        challengeBtn.addEventListener("click", () => {
          socket.emit("challengeUser", user.socketId);
        });
        li.appendChild(challengeBtn);
      }

      usersList.appendChild(li);
    });
  });

  // Challenge
  socket.on("challengeRequest", ({ from, fromUsername }) => {
    const accept = confirm(`${fromUsername} challenged you! Accept?`);
    socket.emit("challengeResponse", { from, accepted: accept });
  });

  socket.on("challengeDeclined", ({ reason }) => {
    alert(reason);
  });

  // ---------------------------
  // 2) Play with Bot
  // ---------------------------
  playBotBtn.addEventListener("click", () => {
    socket.emit("playWithBot");
  });

  // ---------------------------
  // 3) Start Game
  // ---------------------------
  socket.on("startGame", (gameState) => {
    currentGame = gameState;
    // Find out if I'm player0 or player1
    myPlayerIndex = currentGame.players.findIndex(p => p.socketId === socket.id);

    lobbyContainer.classList.add("hidden");
    gameContainer.classList.remove("hidden");

    renderGame();
  });

  // ---------------------------
  // 4) Update Game
  // ---------------------------
  socket.on("updateGame", (gameState) => {
    currentGame = gameState;
    renderGame();
  });

  // If tie again
  socket.on("tieAgain", () => {
    tieMessage.textContent = "Tie again! Pick another item.";
  });

  // ---------------------------
  // 5) Reshuffle & Ready
  // ---------------------------
  reshuffleBtn.addEventListener("click", () => {
    if (!currentGame) return;
    socket.emit("requestReshuffle", { gameId: currentGame.gameId });
  });

  readyBtn.addEventListener("click", () => {
    if (!currentGame) return;
    socket.emit("playerReady", { gameId: currentGame.gameId });
  });

  // ---------------------------
  // 6) Render Game
  // ---------------------------
  function renderGame() {
    if (!currentGame) return;

    // Show status
    if (currentGame.state === "setup") {
      gameStatus.textContent = "Setup phase (You can reshuffle, then click Ready)";
      reshuffleBtn.disabled = false;
      readyBtn.disabled = false;
      replayBtn.classList.add("hidden");
      exitLobbyBtn.classList.add("hidden");
    } else if (currentGame.state === "playing") {
      gameStatus.textContent = "Playing";
      reshuffleBtn.disabled = true;
      readyBtn.disabled = true;
      replayBtn.classList.add("hidden");
      exitLobbyBtn.classList.add("hidden");
    } else if (currentGame.state === "finished") {
      // Show winner if any
      if (currentGame.winner) {
        gameStatus.textContent = `Game Over! Winner: ${currentGame.winner}`;
      } else {
        gameStatus.textContent = "Game Over!";
      }
      reshuffleBtn.disabled = true;
      readyBtn.disabled = true;
      replayBtn.classList.remove("hidden");
      exitLobbyBtn.classList.remove("hidden");
    }

    // Update reshuffle text
    const me = currentGame.players[myPlayerIndex];
    if (me) {
      reshuffleBtn.textContent = `Reshuffle (${me.reshuffles} left)`;
    }

    // Turn info
    if (currentGame.state === "playing") {
      const currentP = currentGame.players[currentGame.currentPlayerIndex];
      turnInfo.textContent = `It's ${currentP.username}'s turn.`;
    } else {
      turnInfo.textContent = "";
    }

    // Render board
    boardElement.innerHTML = "";

    // We'll not do the "flip" logic in this version, but you can re-implement if you want each user to see themselves at bottom:
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 7; c++) {
        const cellDiv = document.createElement("div");
        cellDiv.classList.add("cell");
        cellDiv.dataset.row = r;
        cellDiv.dataset.col = c;

        const cellData = currentGame.board[r][c];
        if (cellData) {
          // color by owner
          cellDiv.classList.add(`owner${cellData.owner}`);
          // if it's revealed or belongs to me, show item
          if (cellData.owner === myPlayerIndex || cellData.revealed || cellData.item === "tie") {
            if (cellData.item === "tie") {
              cellDiv.textContent = "TIE";
            } else {
              cellDiv.textContent = cellData.item[0].toUpperCase();
            }
          } else {
            cellDiv.textContent = "?";
          }
        }

        // If it's my turn, let me move
        if (
          currentGame.state === "playing" &&
          !currentGame.waitingForTieBreak &&
          currentGame.currentPlayerIndex === myPlayerIndex &&
          currentGame.state !== "finished"
        ) {
          cellDiv.addEventListener("click", onCellClick);
        }

        boardElement.appendChild(cellDiv);
      }
    }

    // Tie break modal
    if (currentGame.waitingForTieBreak) {
      tieBreakModal.classList.remove("hidden");
      tieMessage.textContent = "";
    } else {
      tieBreakModal.classList.add("hidden");
    }
  }

  function onCellClick(e) {
    const cell = e.currentTarget;
    const row = parseInt(cell.dataset.row, 10);
    const col = parseInt(cell.dataset.col, 10);

    if (!selectedCell) {
      // If there's a soldier of mine
      const occupant = currentGame.board[row][col];
      if (occupant && occupant.owner === myPlayerIndex) {
        selectedCell = { row, col };
        cell.style.outline = "2px solid red";
      }
    } else {
      // This click is the destination
      const fromRow = selectedCell.row;
      const fromCol = selectedCell.col;

      socket.emit("playerMove", {
        gameId: currentGame.gameId,
        fromRow,
        fromCol,
        toRow: row,
        toCol: col
      });

      selectedCell = null;
      renderGame();
    }
  }

  // ---------------------------
  // 7) Tie break
  // ---------------------------
  tieBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!currentGame) return;
      const newItem = btn.dataset.item;
      socket.emit("tieBreakChoice", {
        gameId: currentGame.gameId,
        newItem
      });
    });
  });

  // ---------------------------
  // 8) Replay
  // ---------------------------
  replayBtn.addEventListener("click", () => {
    if (!currentGame) return;
    socket.emit("requestReplay", { gameId: currentGame.gameId });
  });

  // ---------------------------
  // 9) Exit to Lobby
  // ---------------------------
  exitLobbyBtn.addEventListener("click", () => {
    if (!currentGame) return;
    socket.emit("exitToLobby", { gameId: currentGame.gameId });
  });

  socket.on("returnedToLobby", () => {
    gameContainer.classList.add("hidden");
    lobbyContainer.classList.remove("hidden");
    currentGame = null;
    myPlayerIndex = null;
    selectedCell = null;
  });

  // ---------------------------
  // Global errors
  // ---------------------------
  socket.on("errorOccurred", (msg) => {
    alert(msg);
  });
})();
