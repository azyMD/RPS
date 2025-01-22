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
  const boardContainer = document.getElementById("boardContainer");
  const replayBtn = document.getElementById("replayBtn");
  const exitLobbyBtn = document.getElementById("exitLobbyBtn");

  const tieBreakModal = document.getElementById("tieBreakModal");
  const tieBtns = document.querySelectorAll(".tie-btn");
  const tieMessage = document.getElementById("tieMessage");

  // Local states
  let currentGame = null;
  let myPlayerIndex = null;
  let selectedSoldierId = null; // which soldier I'm currently moving
  let soldiers = []; // array of { id, row, col, owner, item, revealed, element }

  // Constants for cell size
  const CELL_WIDTH = 50;
  const CELL_HEIGHT = 50;

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
    myPlayerIndex = currentGame.players.findIndex(p => p.socketId === socket.id);

    lobbyContainer.classList.add("hidden");
    gameContainer.classList.remove("hidden");

    // Initialize or reset soldier array
    soldiers = [];
    updateSoldiersFromBoard(gameState.board);

    renderUI();
  });

  // ---------------------------
  // 4) Update Game
  // ---------------------------
  socket.on("updateGame", (gameState) => {
    currentGame = gameState;
    updateSoldiersFromBoard(gameState.board);
    renderUI();
  });

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
  // 6) Render UI
  // ---------------------------
  function renderUI() {
    if (!currentGame) return;

    // Status
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

    // Turn info
    if (currentGame.state === "playing") {
      const currentP = currentGame.players[currentGame.currentPlayerIndex];
      turnInfo.textContent = `It's ${currentP.username}'s turn.`;
    } else {
      turnInfo.textContent = "";
    }

    // Tie modal
    if (currentGame.waitingForTieBreak) {
      tieBreakModal.classList.remove("hidden");
      tieMessage.textContent = "";
    } else {
      tieBreakModal.classList.add("hidden");
    }
  }

  // ---------------------------
  // 7) Soldiers, partial re-render & animations
  // ---------------------------
  function updateSoldiersFromBoard(board) {
    // Mark all existing soldiers as "seen" = false
    soldiers.forEach(s => { s.seen = false; });

    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 7; c++) {
        const cell = board[r][c];
        if (cell) {
          const { soldierId, owner, item, revealed } = cell;
          // Find existing soldier
          let soldier = soldiers.find(s => s.id === soldierId);
          if (soldier) {
            // Mark as seen
            soldier.seen = true;
            // If position changed, animate
            if (soldier.row !== r || soldier.col !== c) {
              soldier.row = r;
              soldier.col = c;
              // We'll update DOM position
              positionSoldierElement(soldier);
            }
            // Update item / revealed / owner
            soldier.item = item;
            soldier.revealed = revealed;
            soldier.owner = owner;
            updateSoldierContent(soldier);
          } else {
            // It's a new soldier
            const newS = {
              id: soldierId,
              row: r,
              col: c,
              owner,
              item,
              revealed,
              element: null, // we'll create it
              seen: true
            };
            createSoldierElement(newS);
            soldiers.push(newS);
          }
        }
      }
    }

    // Soldiers that were not "seen" => they've been removed
    soldiers
      .filter(s => !s.seen)
      .forEach(soldier => removeSoldierElement(soldier));

    // Purge them from the array
    soldiers = soldiers.filter(s => s.seen);
  }

  function createSoldierElement(soldier) {
    const el = document.createElement("div");
    el.classList.add("soldier", "new-soldier");
    el.classList.add(`owner${soldier.owner}`);
    // set text
    updateSoldierContent({ ...soldier, element: el });

    // place it
    el.style.left = soldier.col * CELL_WIDTH + "px";
    el.style.top = soldier.row * CELL_HEIGHT + "px";

    // add event listener if it's my turn to pick
    el.addEventListener("click", () => onSoldierClick(soldier.id));

    boardContainer.appendChild(el);
    soldier.element = el;
  }

  function removeSoldierElement(soldier) {
    // Optionally do a fade-out
    soldier.element.classList.add("dying");
    setTimeout(() => {
      if (soldier.element && soldier.element.parentNode) {
        soldier.element.parentNode.removeChild(soldier.element);
      }
      soldier.element = null;
    }, 400);
  }

  function positionSoldierElement(soldier) {
    // Animate by updating .style.left/top
    if (soldier.element) {
      soldier.element.style.left = soldier.col * CELL_WIDTH + "px";
      soldier.element.style.top = soldier.row * CELL_HEIGHT + "px";
      soldier.element.classList.remove(`owner0`, `owner1`);
      soldier.element.classList.add(`owner${soldier.owner}`);
    }
  }

  function updateSoldierContent(soldier) {
    if (!soldier.element) return;
    soldier.element.textContent = "?";
    if (soldier.owner === myPlayerIndex || soldier.revealed || soldier.item === "tie") {
      if (soldier.item === "tie") {
        soldier.element.textContent = "TIE";
      } else {
        soldier.element.textContent = soldier.item[0].toUpperCase(); // "R"/"P"/"S"
      }
    }
  }

  // Clicking a soldier to move
  function onSoldierClick(soldierId) {
    // If it's not my turn or game not playing, do nothing
    if (!currentGame || currentGame.state !== "playing") return;
    if (currentGame.currentPlayerIndex !== myPlayerIndex) return;
    if (currentGame.waitingForTieBreak) return;

    const soldier = soldiers.find(s => s.id === soldierId);
    if (!soldier) return;
    if (soldier.owner !== myPlayerIndex) return;

    // If we haven't selected anything yet
    if (!selectedSoldierId) {
      selectedSoldierId = soldierId;
      soldier.element.style.outline = "2px solid red";
    } else if (selectedSoldierId === soldierId) {
      // clicked same soldier => deselect
      selectedSoldierId = null;
      soldier.element.style.outline = "none";
    } else {
      // we had a soldier selected, now we clicked a different soldier
      // maybe we ignore or just reselect
      // for simplicity, let's just reselect
      const oldSoldier = soldiers.find(s => s.id === selectedSoldierId);
      if (oldSoldier && oldSoldier.element) {
        oldSoldier.element.style.outline = "none";
      }
      selectedSoldierId = soldierId;
      soldier.element.style.outline = "2px solid red";
    }
  }

  // Also handle click on empty board space to move soldier
  boardContainer.addEventListener("click", (e) => {
    // get the offset
    if (!selectedSoldierId) return;
    // If they clicked on the soldier itself, it triggers soldier click above
    // We only proceed if they clicked on "empty" space within boardContainer
    const rect = boardContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const col = Math.floor(x / CELL_WIDTH);
    const row = Math.floor(y / CELL_HEIGHT);

    // If they didn't click exactly on the soldier, we consider it "destination"
    // We'll attempt the move
    attemptMove(selectedSoldierId, row, col);
  });

  function attemptMove(soldierId, toRow, toCol) {
    const soldier = soldiers.find(s => s.id === soldierId);
    if (!soldier) return;

    // We'll emit "playerMove" with fromRow/fromCol => soldier's position
    socket.emit("playerMove", {
      gameId: currentGame.gameId,
      fromRow: soldier.row,
      fromCol: soldier.col,
      toRow,
      toCol
    });

    // unselect soldier
    soldier.element.style.outline = "none";
    selectedSoldierId = null;
  }

  // ---------------------------
  // 8) Tie break
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
  // 9) Replay & Exit
  // ---------------------------
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
    selectedSoldierId = null;
    soldiers = [];
    boardContainer.innerHTML = "";
  });

  // ---------------------------
  // 10) Error handling
  // ---------------------------
  socket.on("errorOccurred", (msg) => {
    alert(msg);
  });
})();
