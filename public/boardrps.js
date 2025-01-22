(() => {
  const socket = io();

  // DOM references
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

  const topPlayerName = document.getElementById("topPlayerName");
  const bottomPlayerName = document.getElementById("bottomPlayerName");
  const boardElement = document.getElementById("board");

  const tieBreakModal = document.getElementById("tieBreakModal");
  const tieBtns = document.querySelectorAll(".tie-btn");
  const tieMessage = document.getElementById("tieMessage");

  // State
  let currentGame = null;
  let myPlayerIndex = null; // 0 or 1
  let selectedCell = null;  // { row, col } of the soldier you want to move

  // ---------------------------
  // 1) Join Lobby
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

  // Render Lobby Data
  socket.on("lobbyData", (users) => {
    usersList.innerHTML = "";
    users.forEach((user) => {
      const li = document.createElement("li");
      let txt = user.username;
      if (user.inGame) txt += " (in-game)";
      li.textContent = txt;

      // Challenge button if user is free and not me
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

  // Handle Challenge Request
  socket.on("challengeRequest", ({ from, fromUsername }) => {
    const accept = confirm(`${fromUsername} challenged you! Accept?`);
    socket.emit("challengeResponse", { from, accepted: accept });
  });

  socket.on("challengeDeclined", ({ reason }) => {
    alert(reason);
  });

  // ---------------------------
  // 2) Start Game
  // ---------------------------
  socket.on("startGame", (gameState) => {
    currentGame = gameState;
    // Determine if I'm player0 or player1
    myPlayerIndex = currentGame.players.findIndex(p => p.socketId === socket.id);

    lobbyContainer.classList.add("hidden");
    gameContainer.classList.remove("hidden");

    renderGame();
  });

  // ---------------------------
  // 3) Update Game
  // ---------------------------
  socket.on("updateGame", (gameState) => {
    currentGame = gameState;
    renderGame();
  });

  // Tie again signal
  socket.on("tieAgain", () => {
    tieMessage.textContent = "Tie again! Pick another item.";
  });

  // ---------------------------
  // 4) Reshuffle & Ready
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
  // 5) Render the Board / UI
  // ---------------------------
  function renderGame() {
    if (!currentGame) return;

    // Game status
    if (currentGame.state === "setup") {
      gameStatus.textContent = "Setup phase (You can reshuffle, then click Ready)";
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

    // Show player names at top/bottom
    const p0name = currentGame.players[0].username;
    const p1name = currentGame.players[1].username;
    if (myPlayerIndex === 0) {
      // I'm player0 => top is player1, bottom is me
      topPlayerName.textContent = p1name;
      bottomPlayerName.textContent = p0name;
    } else {
      // I'm player1 => top is player0, bottom is me
      topPlayerName.textContent = p0name;
      bottomPlayerName.textContent = p1name;
    }

    // Clear the board
    boardElement.innerHTML = "";

    // We want to flip the board so each player sees their soldiers at the bottom.
    // Player0 physically occupies rows 0..1 (top) => we invert the row order for them.
    // Player1 physically occupies rows 4..5 (bottom) => no flip needed if they see it "as is."
    let rowSequence;
    if (myPlayerIndex === 0) {
      // Show row5 first, down to row0
      rowSequence = [5, 4, 3, 2, 1, 0];
    } else {
      // Normal top-to-bottom
      rowSequence = [0, 1, 2, 3, 4, 5];
    }

    const board = currentGame.board;
    for (let r of rowSequence) {
      for (let c = 0; c < 7; c++) {
        const cellDiv = document.createElement("div");
        cellDiv.classList.add("cell");
        // Store real row/col for click events
        cellDiv.dataset.row = r;
        cellDiv.dataset.col = c;

        const cellData = board[r][c];
        if (cellData) {
          const { owner, item, revealed } = cellData;
          if (owner !== null) {
            cellDiv.classList.add(`owner${owner}`);
          }
          // Show the soldier's item if:
          // (a) It's mine, or
          // (b) It's revealed, or
          // (c) It's "tie" placeholder
          if (owner === myPlayerIndex) {
            // Always see my item
            cellDiv.textContent = item[0].toUpperCase();
          } else {
            // Enemy soldier => show if revealed
            if (item === "tie") {
              cellDiv.textContent = "TIE";
            } else if (revealed) {
              cellDiv.textContent = item[0].toUpperCase();
            } else {
              cellDiv.textContent = "?";
            }
          }
        }

        // If it's my turn, let me pick or move
        if (
          currentGame.state === "playing" &&
          currentGame.currentPlayerIndex === myPlayerIndex &&
          !currentGame.waitingForTieBreak &&
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

  // ---------------------------
  // 6) Board Click Handling
  // ---------------------------
  function onCellClick(e) {
    const cell = e.currentTarget;
    const row = parseInt(cell.dataset.row, 10);
    const col = parseInt(cell.dataset.col, 10);

    // If we haven't selected a soldier yet, check if this cell is my soldier
    if (!selectedCell) {
      const occupant = currentGame.board[row][col];
      if (occupant && occupant.owner === myPlayerIndex) {
        selectedCell = { row, col };
        cell.style.outline = "2px solid red";
      }
    } else {
      // We already have a soldier selected, so this cell is the destination
      const fromRow = selectedCell.row;
      const fromCol = selectedCell.col;

      socket.emit("playerMove", {
        gameId: currentGame.gameId,
        fromRow,
        fromCol,
        toRow: row,
        toCol: col
      });

      // Clear selection
      selectedCell = null;
      renderGame(); // Re-render to remove the red outline, etc.
    }
  }

  // ---------------------------
  // 7) Tie Break: re-pick items
  // ---------------------------
  tieBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!currentGame) return;
      const newItem = btn.dataset.item; // "rock" / "paper" / "scissors"
      socket.emit("tieBreakChoice", {
        gameId: currentGame.gameId,
        newItem
      });
    });
  });

  // ---------------------------
  // Global Error Handling
  // ---------------------------
  socket.on("errorOccurred", (msg) => {
    alert(msg);
  });
})();
