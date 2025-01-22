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

  // State
  let currentGame = null;
  let myPlayerIndex = null;
  let selectedCell = null; // {row, col} of soldier I'm moving
  let oldBoard = null; // store the previous board to detect occupant changes

  // 1) Join Lobby
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
    users.forEach((u) => {
      const li = document.createElement("li");
      let txt = u.username + (u.inGame ? " (in-game)" : "");
      li.textContent = txt;
      if (!u.inGame && u.socketId !== socket.id) {
        const btn = document.createElement("button");
        btn.textContent = "Challenge";
        btn.style.marginLeft = "10px";
        btn.addEventListener("click", () => {
          socket.emit("challengeUser", u.socketId);
        });
        li.appendChild(btn);
      }
      usersList.appendChild(li);
    });
  });
  socket.on("challengeRequest", ({ from, fromUsername }) => {
    const accept = confirm(`${fromUsername} challenged you! Accept?`);
    socket.emit("challengeResponse", { from, accepted: accept });
  });
  socket.on("challengeDeclined", ({ reason }) => alert(reason));

  // 2) Play with Bot
  playBotBtn.addEventListener("click", () => {
    socket.emit("playWithBot");
  });

  // 3) Start Game
  socket.on("startGame", (gameState) => {
    currentGame = gameState;
    myPlayerIndex = currentGame.players.findIndex(p => p.socketId === socket.id);

    lobbyContainer.classList.add("hidden");
    gameContainer.classList.remove("hidden");

    oldBoard = null; // reset
    renderGame();
  });

  // 4) Update Game
  socket.on("updateGame", (gameState) => {
    currentGame = gameState;
    renderGame();
  });

  socket.on("tieAgain", () => {
    tieMessage.textContent = "Tie again! Pick another item.";
  });

  // 5) Reshuffle & Ready
  reshuffleBtn.addEventListener("click", () => {
    if (!currentGame) return;
    socket.emit("requestReshuffle", { gameId: currentGame.gameId });
  });
  readyBtn.addEventListener("click", () => {
    if (!currentGame) return;
    socket.emit("playerReady", { gameId: currentGame.gameId });
  });

  // 6) Render Game
  function renderGame() {
    if (!currentGame) return;

    // State
    if (currentGame.state === "setup") {
      gameStatus.textContent = "Setup phase (reshuffle if needed, then Ready)";
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
    // Turn Info
    if (currentGame.state === "playing") {
      const cp = currentGame.players[currentGame.currentPlayerIndex];
      turnInfo.textContent = `It's ${cp.username}'s turn.`;
    } else {
      turnInfo.textContent = "";
    }

    // Tie Modal
    if (currentGame.waitingForTieBreak) {
      tieBreakModal.classList.remove("hidden");
      tieMessage.textContent = "";
    } else {
      tieBreakModal.classList.add("hidden");
    }

    // Render board with perspective flip
    boardElement.innerHTML = "";
    let rowSequence;
    if (myPlayerIndex === 0) {
      // flip
      rowSequence = [5,4,3,2,1,0];
    } else {
      rowSequence = [0,1,2,3,4,5];
    }

    // Build new <div> cells row by row
    for (let rIdx = 0; rIdx < 6; rIdx++) {
      const realRow = rowSequence[rIdx];
      for (let c = 0; c < 7; c++) {
        const cellData = currentGame.board[realRow][c];
        // create cell
        const cellDiv = document.createElement("div");
        cellDiv.classList.add("cell");

        // chess coloring
        if ((rIdx + c) % 2 === 0) {
          cellDiv.classList.add("chessLight");
        } else {
          cellDiv.classList.add("chessDark");
        }

        // occupant
        if (cellData) {
          if (cellData.item === "tie") {
            // tie occupant
            cellDiv.textContent = "TIE";
          } else if (cellData.owner === myPlayerIndex || cellData.revealed) {
            // show actual item
            cellDiv.textContent = cellData.item[0].toUpperCase(); // "R"/"P"/"S"
          } else {
            // hidden
            cellDiv.textContent = "?";
          }
          // color by owner
          cellDiv.classList.add(`owner${cellData.owner}`);
        } else {
          cellDiv.textContent = "";
        }

        // Minimal "changed occupant" animation
        if (oldBoard) {
          // Compare occupant in oldBoard
          const oldCell = oldBoard[realRow][c];
          const oldOwner = oldCell ? oldCell.owner : null;
          const newOwner = cellData ? cellData.owner : null;
          // if occupant changed, flash
          if (oldOwner !== newOwner) {
            cellDiv.classList.add("changed");
          }
        }

        // add click event if it's my turn
        if (
          currentGame.state === "playing" &&
          currentGame.currentPlayerIndex === myPlayerIndex &&
          !currentGame.waitingForTieBreak
        ) {
          cellDiv.addEventListener("click", () => onCellClick(realRow, c, cellData));
        }

        boardElement.appendChild(cellDiv);
      }
    }

    // store a copy of the board for next time
    oldBoard = copyBoard(currentGame.board);
  }

  function copyBoard(board) {
    const nb = [];
    for (let r = 0; r < 6; r++) {
      nb[r] = [];
      for (let c = 0; c < 7; c++) {
        if (!board[r][c]) {
          nb[r][c] = null;
        } else {
          nb[r][c] = { ...board[r][c] };
        }
      }
    }
    return nb;
  }

  // When player clicks a cell
  function onCellClick(row, col, cellData) {
    // If we haven't selected a soldier yet
    if (!selectedCell) {
      // Check if there's a soldier owned by me
      if (cellData && cellData.owner === myPlayerIndex) {
        // select it
        selectedCell = { row, col };
      }
    } else {
      // We already have a soldier selected => attempt move
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
    }
  }

  // 7) Tie break
  tieBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      if (!currentGame) return;
      const newItem = btn.dataset.item;
      socket.emit("tieBreakChoice", {
        gameId: currentGame.gameId,
        newItem
      });
    });
  });

  // 8) Replay & Exit
  replayBtn.addEventListener("click", () => {
    if (!currentGame) return;
    socket.emit("requestReplay", { gameId: currentGame.gameId });
  });
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
    oldBoard = null;
    boardElement.innerHTML = "";
  });

  // 9) Error
  socket.on("errorOccurred", (msg) => {
    alert(msg);
  });
})();
