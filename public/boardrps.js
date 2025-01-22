(() => {
  const socket = io();

  // DOM
  const loginContainer = document.getElementById("loginContainer");
  const usernameInput = document.getElementById("usernameInput");
  const joinBtn = document.getElementById("joinBtn");

  const lobbyContainer = document.getElementById("lobbyContainer");
  const usersList = document.getElementById("usersList");

  const gameContainer = document.getElementById("gameContainer");
  const gameStatus = document.getElementById("gameStatus");
  const reshuffleBtn = document.getElementById("reshuffleBtn");
  const readyBtn = document.getElementById("readyBtn");
  const turnInfo = document.getElementById("turnInfo");
  const boardElement = document.getElementById("board");

  const tieBreakModal = document.getElementById("tieBreakModal");
  const tieBtns = document.querySelectorAll(".tie-btn");
  const tieMessage = document.getElementById("tieMessage");

  let currentGame = null;       // local copy of gameState
  let myPlayerIndex = null;     // 0 or 1
  let selectedCell = null;      // {row, col} or null

  // ---------------------------
  // Lobby / Login
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
    users.forEach(user => {
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

  socket.on("challengeRequest", ({ from, fromUsername }) => {
    const accept = confirm(`${fromUsername} challenged you! Accept?`);
    socket.emit("challengeResponse", { from, accepted: accept });
  });

  socket.on("challengeDeclined", ({ reason }) => {
    alert(reason);
  });

  // ---------------------------
  // Start Game
  // ---------------------------
  socket.on("startGame", (gameState) => {
    currentGame = gameState;
    myPlayerIndex = currentGame.players.findIndex(p => p.socketId === socket.id);

    // Show game container
    lobbyContainer.classList.add("hidden");
    gameContainer.classList.remove("hidden");

    renderGame();
  });

  // ---------------------------
  // Update Game
  // ---------------------------
  socket.on("updateGame", (gameState) => {
    currentGame = gameState;
    if (!currentGame) return;
    renderGame();
  });

  // If tie happens again
  socket.on("tieAgain", (gameState) => {
    // Means the server is letting us know there's another tie
    tieMessage.textContent = "Tie again! Pick another item.";
  });

  // ---------------------------
  // Reshuffle / Ready
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
  // Render the board
  // ---------------------------
  function renderGame() {
    if (!currentGame) return;

    // Update game status
    if (currentGame.state === "setup") {
      gameStatus.textContent = "Setup phase (You can reshuffle or press Ready)";
      reshuffleBtn.disabled = false;
      readyBtn.disabled = false;
    } else if (currentGame.state === "playing") {
      gameStatus.textContent = "Playing";
      reshuffleBtn.disabled = true;
      readyBtn.disabled = true;
    } else if (currentGame.state === "finished") {
      if (currentGame.winner) {
        gameStatus.textContent = `Game Over! Winner: ${currentGame.winner}`;
      } else {
        gameStatus.textContent = "Game Over!";
      }
      reshuffleBtn.disabled = true;
      readyBtn.disabled = true;
    }

    // Update reshuffle button text
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

    const board = currentGame.board;
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 7; c++) {
        const cellDiv = document.createElement("div");
        cellDiv.classList.add("cell");
        cellDiv.dataset.row = r;
        cellDiv.dataset.col = c;

        const cellData = board[r][c];
        if (cellData) {
          // Show occupant
          if (cellData.owner !== null) {
            cellDiv.classList.add(`owner${cellData.owner}`);
          }
          // If revealed, show item (R/P/S)
          if (cellData.revealed && cellData.item !== "tie") {
            cellDiv.textContent = cellData.item[0].toUpperCase(); // "R"/"P"/"S"
          } else if (cellData.item === "tie") {
            cellDiv.textContent = "TIE";
          } else {
            // Hidden
            cellDiv.textContent = "?";
          }
        } else {
          cellDiv.textContent = "";
        }

        // If it's my turn and game is "playing," let me pick a soldier or move
        if (currentGame.state === "playing" &&
            currentGame.currentPlayerIndex === myPlayerIndex &&
            !currentGame.waitingForTieBreak &&
            currentGame.state !== "finished") {
          cellDiv.addEventListener("click", onCellClick);
        }

        boardElement.appendChild(cellDiv);
      }
    }

    // Show/hide tieBreakModal
    if (currentGame.waitingForTieBreak) {
      tieBreakModal.classList.remove("hidden");
      tieMessage.textContent = "";
    } else {
      tieBreakModal.classList.add("hidden");
    }
  }

  // ---------------------------
  // Clicking on the board
  // ---------------------------
  function onCellClick(e) {
    const cell = e.currentTarget;
    const row = parseInt(cell.dataset.row, 10);
    const col = parseInt(cell.dataset.col, 10);

    // If we haven't selected a soldier yet
    if (!selectedCell) {
      // See if there's a soldier of mine there
      const occupant = currentGame.board[row][col];
      if (occupant && occupant.owner === myPlayerIndex) {
        // select it
        selectedCell = { row, col };
        cell.style.outline = "2px solid red";
      }
    } else {
      // We have a selected cell, so this click is the "destination"
      const fromRow = selectedCell.row;
      const fromCol = selectedCell.col;

      // Attempt move
      socket.emit("playerMove", {
        gameId: currentGame.gameId,
        fromRow,
        fromCol,
        toRow: row,
        toCol: col
      });

      // Clear selection
      selectedCell = null;
      renderGame();
    }
  }

  // ---------------------------
  // Tie Break Handling
  // ---------------------------
  tieBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const newItem = btn.dataset.item; // "rock"/"paper"/"scissors"
      if (!currentGame) return;
      socket.emit("tieBreakChoice", {
        gameId: currentGame.gameId,
        newItem
      });
    });
  });

  // ---------------------------
  // Global error handling
  // ---------------------------
  socket.on("errorOccurred", (msg) => {
    alert(msg);
  });
})();
