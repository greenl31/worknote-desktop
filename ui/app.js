(function () {
  "use strict";

  const LEGACY_STORAGE_KEY = "worknote.tasks.v1";
  const MIGRATION_STORAGE_KEY = "worknote.sqlite.migrated.v1";
  const UI_MODE_STORAGE_KEY = "worknote.ui.windowMode.v4";
  const SELECTED_DATE_STORAGE_KEY = "worknote.ui.selectedDate.v1";
  const WINDOW_SHOWN_EVENT = "main-window-shown";
  const WINDOW_FOCUSED_EVENT = "main-window-focused";
  const EDGE_TAB_Y_STORAGE_KEY = "worknote.ui.edgeTabY.v1";
  const EDGE_SIDE_STORAGE_KEY = "worknote.ui.edgeSide.v1";
  const RECENT_SUMMARY_LIMIT = 3;
  const DAILY_BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
  const DATE_REFRESH_INTERVAL_MS = 30 * 1000;
  const STARTUP_DATE_REFRESH_DELAYS_MS = [1000, 5000, 15000];
  const EDGE_IDLE_COLLAPSE_DELAY_MS = 3000;
  const EDGE_MOUSELEAVE_COLLAPSE_DELAY_MS = 3000;
  const EDGE_EXPAND_GRACE_MS = 450;
  const EDGE_TRANSITION_DEBOUNCE_MS = 260;
  const EDGE_DRAG_THRESHOLD_PX = 5;
  const EDGE_FOCUS_THROTTLE_MS = 500;
  const TASK_PRIORITIES = ["normal", "urgent", "important", "urgent_important"];
  const TASK_PRIORITY_TAGS = ["urgent", "important"];
  const TASK_PRIORITY_RANK = {
    urgent_important: 0,
    urgent: 1,
    important: 2,
    normal: 3,
  };
  const TASK_PRIORITY_LABELS = {
    urgent: "紧急",
    important: "重要",
  };

  const initialDateKey = getTodayDateKey();

  const state = {
    tasks: [],
    summaries: [],
    selectedDate: initialDateKey,
    lastKnownTodayDate: initialDateKey,
    isViewingTodayMode: true,
    calendarViewDate: null,
    datePickerOpen: false,
    dataInfo: null,
    dbReady: false,
    busy: false,
    pendingDeleteTaskId: null,
    clearDoneConfirmVisible: false,
    windowMode: "normal",
    windowModeBusy: false,
    isEdgeCollapsed: false,
    edgeSide: loadEdgeSide(),
    edgeTabY: loadEdgeTabY(),
    edgeDrag: null,
    edgeCollapseTimerId: null,
    edgeTransitionPromise: null,
    lastEdgeTransitionAt: 0,
    lastEdgeExpandedAt: 0,
    lastEdgeFocusedAt: 0,
    isPointerInsideExpandedWindow: false,
    isEditingTask: false,
    editingTaskId: null,
    isComposingText: false,
    dailyBackupTimerId: null,
    dailyBackupPromise: null,
    dateRefreshTimerId: null,
    hasManualHistoricalDateSelection: false,
    newTaskPriority: "normal",
    newTaskIsPrioritized: false,
  };

  const elements = {
    selectedDateText: document.getElementById("selectedDateText"),
    selectedDateButton: document.getElementById("selectedDateButton"),
    datePickerWrap: document.getElementById("datePickerWrap"),
    datePicker: document.getElementById("datePicker"),
    calendarTitle: document.getElementById("calendarTitle"),
    calendarGrid: document.getElementById("calendarGrid"),
    prevMonthButton: document.getElementById("prevMonthButton"),
    nextMonthButton: document.getElementById("nextMonthButton"),
    goTodayButton: document.getElementById("goTodayButton"),
    todoCount: document.getElementById("todoCount"),
    doneCount: document.getElementById("doneCount"),
    taskInput: document.getElementById("taskInput"),
    addButton: document.getElementById("addButton"),
    priorityOptions: document.querySelectorAll("[data-task-priority]"),
    prioritizedOption: document.querySelector("[data-task-prioritized]"),
    windowModeButton: document.getElementById("windowModeButton"),
    todayList: document.getElementById("todayList"),
    tomorrowList: document.getElementById("tomorrowList"),
    inboxList: document.getElementById("inboxList"),
    doneList: document.getElementById("doneList"),
    recentList: document.getElementById("recentList"),
    todayTitle: document.getElementById("todayTitle"),
    tomorrowTitle: document.getElementById("tomorrowTitle"),
    todayEmpty: document.getElementById("todayEmpty"),
    tomorrowEmpty: document.getElementById("tomorrowEmpty"),
    inboxEmpty: document.getElementById("inboxEmpty"),
    doneEmpty: document.getElementById("doneEmpty"),
    recentEmpty: document.getElementById("recentEmpty"),
    clearDoneButton: document.getElementById("clearDoneButton"),
    clearDoneConfirm: document.getElementById("clearDoneConfirm"),
    confirmClearDoneButton: document.getElementById("confirmClearDoneButton"),
    cancelClearDoneButton: document.getElementById("cancelClearDoneButton"),
    dataStatus: document.getElementById("dataStatus"),
    databasePath: document.getElementById("databasePath"),
    dataError: document.getElementById("dataError"),
    exportButton: document.getElementById("exportButton"),
    exportMessage: document.getElementById("exportMessage"),
    edgeLogoTab: document.getElementById("edgeLogoTab"),
  };

  function invokeCommand(command, args) {
    const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (typeof invoke !== "function") {
      return Promise.reject(new Error("Tauri command 不可用，请在桌面应用中打开工作日志。"));
    }

    return invoke(command, args);
  }

  function loadLegacyTasks() {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.filter(isTaskLike).map((task, index) => normalizeLegacyTask(task, index, parsed.length));
    } catch (error) {
      console.error("读取 V0.1 localStorage 任务失败，已跳过自动迁移。", error);
      return [];
    }
  }

  function isTaskLike(task) {
    return task && typeof task.id === "string" && typeof task.title === "string";
  }

  function normalizeLegacyTask(task, index, total) {
    const now = new Date().toISOString();
    const status = isTaskCompleted(task) ? "done" : "todo";
    const createdAt = typeof task.createdAt === "string" && task.createdAt ? task.createdAt : now;
    const completedAt = status === "done" ? getTaskCompletedAt(task) || now : null;
    const updatedAt = typeof task.updatedAt === "string" && task.updatedAt ? task.updatedAt : completedAt || createdAt;

    return {
      id: task.id,
      title: task.title,
      status,
      priority: normalizeTaskPriority(task.priority),
      isPrioritized: task.isPrioritized === true,
      createdAt,
      completedAt,
      projectName: typeof task.projectName === "string" ? task.projectName : null,
      plannedDate: getTaskDate(task),
      sortOrder: Number.isFinite(task.sortOrder) ? task.sortOrder : total - index,
      updatedAt,
    };
  }

  function createTask(title) {
    const now = new Date().toISOString();
    return {
      id: makeId(),
      title,
      status: "todo",
      priority: state.newTaskPriority,
      isPrioritized: state.newTaskIsPrioritized,
      createdAt: now,
      completedAt: null,
      projectName: null,
      plannedDate: state.selectedDate,
      sortOrder: Date.now(),
      updatedAt: now,
    };
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function refreshTasks() {
    state.tasks = await invokeCommand("get_tasks");
    render();
    await refreshDataInfo();
  }

  async function refreshSummaries() {
    state.summaries = await invokeCommand("get_recent_summaries", { limit: RECENT_SUMMARY_LIMIT });
    renderRecentSummaries();
  }

  async function refreshDataInfo() {
    state.dataInfo = await invokeCommand("get_data_info");
    state.dbReady = true;
    renderDataStatus();
  }

  async function migrateLegacyTasksIfNeeded(sqliteTasks) {
    const legacyTasks = loadLegacyTasks();
    if (sqliteTasks.length > 0 || legacyTasks.length === 0) {
      return sqliteTasks;
    }

    try {
      const result = await invokeCommand("import_tasks", { tasks: legacyTasks });
      localStorage.setItem(MIGRATION_STORAGE_KEY, new Date().toISOString());
      console.info("V0.1 localStorage 任务已迁移到 SQLite。", result);
      return await invokeCommand("get_tasks");
    } catch (error) {
      showDataError("旧任务迁移失败，localStorage 已保留。");
      console.error("V0.1 localStorage 任务迁移失败。", error);
      return sqliteTasks;
    }
  }

  async function initializeData() {
    try {
      const sqliteTasks = await invokeCommand("get_tasks");
      state.tasks = await migrateLegacyTasksIfNeeded(sqliteTasks);
      await refreshDataInfo();
      await refreshSummaries();
      await ensureDailyBackup();
      render();
    } catch (error) {
      state.dbReady = false;
      state.tasks = [];
      state.summaries = [];
      showDataError("SQLite 初始化失败，任务暂时无法写入。");
      console.error("SQLite 初始化失败。", error);
      render();
      renderRecentSummaries();
      renderDataStatus();
    }
  }

  async function ensureDailyBackup() {
    if (state.dailyBackupPromise) {
      return state.dailyBackupPromise;
    }

    state.dailyBackupPromise = (async () => {
      try {
        const result = await invokeCommand("ensure_daily_backup", {
          backupDate: yesterdayDate(),
        });
        if (result && result.created) {
          console.info("每日数据备份已创建。", result.filePath || result.backupDir);
        }
      } catch (error) {
        console.error("每日数据备份失败。", error);
      } finally {
        state.dailyBackupPromise = null;
      }
    })();

    return state.dailyBackupPromise;
  }

  function scheduleDailyBackupCheck() {
    if (state.dailyBackupTimerId) {
      return;
    }

    state.dailyBackupTimerId = window.setInterval(() => {
      if (state.dbReady) {
        ensureDailyBackup();
      }
    }, DAILY_BACKUP_CHECK_INTERVAL_MS);
  }

  function yesterdayDate() {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return formatDateInput(date);
  }

  async function addTask() {
    const title = elements.taskInput.value.trim();
    if (!title) {
      elements.taskInput.value = "";
      elements.taskInput.focus();
      return;
    }

    await runDataAction(async () => {
      await invokeCommand("create_task", { task: createTask(title) });
      elements.taskInput.value = "";
      state.newTaskIsPrioritized = false;
      selectNewTaskPriority("normal");
      await refreshTasks();
      elements.taskInput.focus();
    }, "新增任务失败。");
  }

  function selectNewTaskPriority(priority) {
    if (priority === "normal") {
      state.newTaskPriority = "normal";
      renderNewTaskPriorityOptions();
      return;
    }

    if (!TASK_PRIORITY_TAGS.includes(priority)) {
      return;
    }

    state.newTaskPriority = toggleTaskPriorityTag(state.newTaskPriority, priority);
    renderNewTaskPriorityOptions();
  }

  function renderNewTaskPriorityOptions() {
    elements.priorityOptions.forEach((button) => {
      const selected = taskPriorityHasTag(state.newTaskPriority, button.dataset.taskPriority);
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    elements.prioritizedOption.classList.toggle("is-selected", state.newTaskIsPrioritized);
    elements.prioritizedOption.setAttribute("aria-pressed", String(state.newTaskIsPrioritized));
  }

  function toggleNewTaskPrioritized() {
    state.newTaskIsPrioritized = !state.newTaskIsPrioritized;
    renderNewTaskPriorityOptions();
  }

  async function initializeWindowMode() {
    const savedMode = localStorage.getItem(UI_MODE_STORAGE_KEY) === "floating" ? "floating" : "normal";
    applyWindowModeInfo({ mode: savedMode, isFloating: savedMode === "floating" });
    await setWindowMode(savedMode);
    await syncWindowMode();
  }

  async function setWindowMode(mode) {
    if (state.windowModeBusy) {
      return;
    }

    clearEdgeIdleTimer();
    state.windowModeBusy = true;
    renderControls();
    try {
      const info = await invokeCommand("set_window_mode", { mode });
      applyWindowModeInfo(info);
    } catch (error) {
      console.error("切换窗口模式失败。", error);
      await syncWindowMode();
    } finally {
      state.windowModeBusy = false;
      renderControls();
      resetEdgeIdleTimer();
    }
  }

  async function toggleWindowMode() {
    const nextMode = state.windowMode === "floating" ? "normal" : "floating";
    await setWindowMode(nextMode);
  }

  function applyWindowModeInfo(info) {
    const isFloating = Boolean(info && info.isFloating);
    state.windowMode = isFloating ? "floating" : "normal";
    localStorage.setItem(UI_MODE_STORAGE_KEY, state.windowMode);
    document.body.classList.toggle("is-floating-mode", isFloating);
    elements.windowModeButton.textContent = isFloating ? "普通" : "浮窗";
    elements.windowModeButton.setAttribute("aria-pressed", String(isFloating));
    if (!isFloating) {
      state.isEdgeCollapsed = false;
      state.isPointerInsideExpandedWindow = false;
      clearEdgeIdleTimer();
    } else if (!state.isEdgeCollapsed) {
      resetEdgeIdleTimer();
    }
    applyEdgeCollapsedClass();
  }

  async function syncWindowMode() {
    try {
      const info = await invokeCommand("get_window_mode");
      applyWindowModeInfo(info);
    } catch (error) {
      console.error("同步窗口模式失败。", error);
    }
  }

  function clearEdgeIdleTimer() {
    if (!state.edgeCollapseTimerId) {
      return;
    }

    window.clearTimeout(state.edgeCollapseTimerId);
    state.edgeCollapseTimerId = null;
  }

  function resetEdgeIdleTimer() {
    scheduleEdgeCollapse(EDGE_IDLE_COLLAPSE_DELAY_MS);
  }

  function scheduleEdgeCollapse(delayMs = EDGE_IDLE_COLLAPSE_DELAY_MS) {
    clearEdgeIdleTimer();
    if (state.windowMode !== "floating" || state.isEdgeCollapsed || state.isPointerInsideExpandedWindow) {
      return;
    }

    state.edgeCollapseTimerId = window.setTimeout(() => {
      state.edgeCollapseTimerId = null;
      if (canAutoCollapseEdgeWindow()) {
        collapseEdgeWindow();
      } else {
        resetEdgeIdleTimer();
      }
    }, delayMs);
  }

  function canAutoCollapseEdgeWindow() {
    return (
      state.windowMode === "floating" &&
      !state.isEdgeCollapsed &&
      !state.windowModeBusy &&
      !state.edgeTransitionPromise &&
      !state.isPointerInsideExpandedWindow &&
      Date.now() - state.lastEdgeExpandedAt >= EDGE_EXPAND_GRACE_MS &&
      !isEdgeCollapseProtected()
    );
  }

  function isEdgeCollapseProtected() {
    return (
      state.busy ||
      state.isEditingTask ||
      state.datePickerOpen ||
      state.clearDoneConfirmVisible ||
      Boolean(state.pendingDeleteTaskId) ||
      hasActiveInput()
    );
  }

  function hasActiveInput() {
    return isBlockingInputElement(document.activeElement);
  }

  function isInputLike(element) {
    return Boolean(element && (element.matches("input, textarea, select") || element.isContentEditable));
  }

  function isBlockingInputElement(element) {
    if (!isInputLike(element)) {
      return false;
    }

    if (state.isComposingText) {
      return true;
    }

    if (element.isContentEditable) {
      return Boolean(element.textContent && element.textContent.trim());
    }

    return typeof element.value === "string" && Boolean(element.value.trim());
  }

  function blurEmptyActiveInput() {
    const active = document.activeElement;
    if (isInputLike(active) && !isBlockingInputElement(active) && typeof active.blur === "function") {
      active.blur();
    }
  }

  async function collapseEdgeWindow() {
    if (!canAutoCollapseEdgeWindow()) {
      return;
    }

    blurEmptyActiveInput();
    await runEdgeTransition(async () => {
      const info = await invokeCommand("collapse_edge_window", {
        edgeTabY: state.edgeTabY,
      });
      saveEdgeInfo(info);
      state.isEdgeCollapsed = true;
      state.isPointerInsideExpandedWindow = false;
      applyEdgeCollapsedClass();
    });
  }

  async function expandEdgeWindow() {
    clearEdgeIdleTimer();
    if (state.windowMode !== "floating") {
      return;
    }

    await runEdgeTransition(async () => {
      const info = await invokeCommand("expand_edge_window", {
        edgeSide: state.edgeSide,
        edgeTabY: state.edgeTabY,
      });
      saveEdgeInfo(info);
      state.isEdgeCollapsed = false;
      state.isPointerInsideExpandedWindow = true;
      state.lastEdgeExpandedAt = Date.now();
      applyEdgeCollapsedClass();
    }, true);
    resetEdgeIdleTimer();
  }

  async function runEdgeTransition(action, skipDebounce) {
    const now = Date.now();
    if (
      state.edgeTransitionPromise ||
      (!skipDebounce && now - state.lastEdgeTransitionAt < EDGE_TRANSITION_DEBOUNCE_MS)
    ) {
      return state.edgeTransitionPromise;
    }

    state.lastEdgeTransitionAt = now;
    state.edgeTransitionPromise = (async () => {
      try {
        await action();
      } catch (error) {
        console.error("浮窗边缘吸附切换失败。", error);
        state.isEdgeCollapsed = false;
        applyEdgeCollapsedClass();
      } finally {
        state.edgeTransitionPromise = null;
      }
    })();

    return state.edgeTransitionPromise;
  }

  function applyEdgeCollapsedClass() {
    const isCollapsed = state.windowMode === "floating" && state.isEdgeCollapsed;
    document.documentElement.classList.toggle("edge-collapsed", isCollapsed);
    document.documentElement.classList.toggle("edge-side-left", isCollapsed && state.edgeSide === "left");
    document.documentElement.classList.toggle("edge-side-right", isCollapsed && state.edgeSide !== "left");
    document.body.classList.toggle("edge-collapsed", isCollapsed);
    document.body.classList.toggle("edge-side-left", isCollapsed && state.edgeSide === "left");
    document.body.classList.toggle("edge-side-right", isCollapsed && state.edgeSide !== "left");
    document.body.classList.toggle("edge-dragging", Boolean(state.edgeDrag && state.edgeDrag.isDragging));
    elements.edgeLogoTab.setAttribute("aria-hidden", String(!isCollapsed));
  }

  function saveEdgeInfo(info) {
    if (!info) {
      return;
    }

    if (info.edgeSide === "left" || info.edgeSide === "right") {
      state.edgeSide = info.edgeSide;
      localStorage.setItem(EDGE_SIDE_STORAGE_KEY, state.edgeSide);
    }

    if (Number.isFinite(info.edgeTabY)) {
      state.edgeTabY = info.edgeTabY;
      localStorage.setItem(EDGE_TAB_Y_STORAGE_KEY, String(Math.round(info.edgeTabY)));
    }
  }

  function isEdgeTabActive() {
    return state.isEdgeCollapsed || document.body.classList.contains("edge-collapsed");
  }

  async function focusEdgeWindow() {
    if (!isEdgeTabActive()) {
      return;
    }

    const now = Date.now();
    if (now - state.lastEdgeFocusedAt < EDGE_FOCUS_THROTTLE_MS) {
      return;
    }

    state.lastEdgeFocusedAt = now;
    try {
      await invokeCommand("focus_edge_window");
    } catch (error) {
      console.error("聚焦 logo 胶囊失败。", error);
    }
  }

  function startEdgeTabPointer(event) {
    if (!isEdgeTabActive() || event.button !== 0) {
      return;
    }

    if (state.edgeDrag) {
      return;
    }

    event.preventDefault();
    clearEdgeIdleTimer();
    state.edgeDrag = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      startAt: Date.now(),
      grabOffsetX: event.clientX,
      grabOffsetY: event.clientY,
      lastX: event.screenX,
      lastY: event.screenY,
      isDragging: false,
      movePromise: null,
      pendingScreenX: event.screenX,
      pendingScreenY: event.screenY,
      pendingFinal: false,
    };
    elements.edgeLogoTab.setPointerCapture(event.pointerId);
    applyEdgeCollapsedClass();
  }

  function startEdgeTabMouse(event) {
    if (!isEdgeTabActive() || event.button !== 0 || state.edgeDrag) {
      return;
    }

    event.preventDefault();
    clearEdgeIdleTimer();
    state.edgeDrag = {
      pointerId: "mouse",
      startX: event.screenX,
      startY: event.screenY,
      startAt: Date.now(),
      grabOffsetX: event.clientX,
      grabOffsetY: event.clientY,
      lastX: event.screenX,
      lastY: event.screenY,
      isDragging: false,
      movePromise: null,
      pendingScreenX: event.screenX,
      pendingScreenY: event.screenY,
      pendingFinal: false,
    };
    applyEdgeCollapsedClass();
  }

  function moveEdgeTabPointer(event) {
    const drag = state.edgeDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const totalDeltaX = event.screenX - drag.startX;
    const totalDeltaY = event.screenY - drag.startY;
    if (!drag.isDragging && Math.hypot(totalDeltaX, totalDeltaY) < EDGE_DRAG_THRESHOLD_PX) {
      return;
    }

    event.preventDefault();
    drag.isDragging = true;
    applyEdgeCollapsedClass();

    drag.lastX = event.screenX;
    drag.lastY = event.screenY;
    queueEdgeTabMove(event.screenX, event.screenY, false);
  }

  function moveEdgeTabMouse(event) {
    const drag = state.edgeDrag;
    if (!drag || drag.pointerId !== "mouse") {
      return;
    }

    const totalDeltaX = event.screenX - drag.startX;
    const totalDeltaY = event.screenY - drag.startY;
    if (!drag.isDragging && Math.hypot(totalDeltaX, totalDeltaY) < EDGE_DRAG_THRESHOLD_PX) {
      return;
    }

    event.preventDefault();
    drag.isDragging = true;
    applyEdgeCollapsedClass();

    drag.lastX = event.screenX;
    drag.lastY = event.screenY;
    queueEdgeTabMove(event.screenX, event.screenY, false);
  }

  async function finishEdgeTabPointer(event) {
    const drag = state.edgeDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    if (elements.edgeLogoTab.hasPointerCapture(event.pointerId)) {
      elements.edgeLogoTab.releasePointerCapture(event.pointerId);
    }

    if (!drag.isDragging) {
      state.edgeDrag = null;
      applyEdgeCollapsedClass();
      await expandEdgeWindow();
      return;
    }

    drag.lastX = event.screenX;
    drag.lastY = event.screenY;
    await queueEdgeTabMove(event.screenX, event.screenY, true);
    state.edgeDrag = null;
    applyEdgeCollapsedClass();
  }

  async function finishEdgeTabMouse(event) {
    const drag = state.edgeDrag;
    if (!drag || drag.pointerId !== "mouse") {
      return;
    }

    event.preventDefault();
    if (!drag.isDragging) {
      state.edgeDrag = null;
      applyEdgeCollapsedClass();
      await expandEdgeWindow();
      return;
    }

    drag.lastX = event.screenX;
    drag.lastY = event.screenY;
    await queueEdgeTabMove(event.screenX, event.screenY, true);
    state.edgeDrag = null;
    applyEdgeCollapsedClass();
  }

  function cancelEdgeTabPointer(event) {
    const drag = state.edgeDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (elements.edgeLogoTab.hasPointerCapture(event.pointerId)) {
      elements.edgeLogoTab.releasePointerCapture(event.pointerId);
    }
    state.edgeDrag = null;
    applyEdgeCollapsedClass();
  }

  function queueEdgeTabMove(screenX, screenY, isFinal) {
    const drag = state.edgeDrag;
    if (!drag) {
      return Promise.resolve();
    }

    drag.pendingScreenX = screenX;
    drag.pendingScreenY = screenY;
    drag.pendingFinal = drag.pendingFinal || isFinal;

    if (drag.movePromise) {
      return drag.movePromise;
    }

    const flush = async () => {
      const nextScreenX = drag.pendingScreenX;
      const nextScreenY = drag.pendingScreenY;
      const nextIsFinal = drag.pendingFinal;
      drag.pendingFinal = false;

      if (Number.isFinite(nextScreenX) && Number.isFinite(nextScreenY)) {
        try {
          const info = await invokeCommand("move_edge_tab", {
            screenX: nextScreenX,
            screenY: nextScreenY,
            grabOffsetX: drag.grabOffsetX,
            grabOffsetY: drag.grabOffsetY,
            isFinal: nextIsFinal,
          });
          saveEdgeInfo(info);
          applyEdgeCollapsedClass();
        } catch (error) {
          console.error("移动 logo 胶囊失败。", error);
        }
      }

      if (drag.pendingFinal || drag.pendingScreenX !== nextScreenX || drag.pendingScreenY !== nextScreenY) {
        return flush();
      }

      drag.movePromise = null;
      return null;
    };

    drag.movePromise = flush();
    return drag.movePromise;
  }

  async function toggleTask(id) {
    cancelDeleteTask();
    const task = state.tasks.find((item) => item.id === id);
    if (!task) {
      return;
    }

    if (isTaskCompleted(task)) {
      await restoreCompletedTask(task);
      return;
    }

    await runDataAction(async () => {
      await patchTaskCompleted(id);
      await refreshTasks();
    }, "更新任务状态失败。");
  }

  async function moveTaskToTomorrow(id) {
    await moveTaskToDate(id, nextDate(state.selectedDate), "延后任务失败。");
  }

  async function moveTaskToToday(id) {
    await moveTaskToDate(id, todayDate(), "移到今日失败。");
  }

  function findTaskById(id) {
    return state.tasks.find((item) => item.id === id);
  }

  function startEditTaskTitle(id) {
    cancelDeleteTask();
    clearEdgeIdleTimer();
    clearDataError();
    const task = findTaskById(id);
    if (!task) {
      showDataError("任务不存在，可能已被删除。");
      resetEdgeIdleTimer();
      return;
    }

    if (isTaskCompleted(task)) {
      showDataError("已完成任务请先恢复为代办后再修改。");
      resetEdgeIdleTimer();
      return;
    }

    state.isEditingTask = true;
    state.editingTaskId = id;
    state.pendingDeleteTaskId = null;
    state.clearDoneConfirmVisible = false;
    render();
    renderClearDoneConfirm();

    window.setTimeout(() => {
      const input = document.querySelector(`[data-edit-task-id="${CSS.escape(id)}"]`);
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }

  function cancelEditTaskTitle() {
    if (!state.editingTaskId) {
      return;
    }

    state.editingTaskId = null;
    state.isEditingTask = false;
    render();
    resetEdgeIdleTimer();
  }

  async function saveEditTaskTitle(id) {
    const task = findTaskById(id);
    if (!task) {
      showDataError("任务不存在，可能已被删除。");
      cancelEditTaskTitle();
      return;
    }

    if (isTaskCompleted(task)) {
      showDataError("已完成任务请先恢复为代办后再修改。");
      cancelEditTaskTitle();
      return;
    }

    const input = document.querySelector(`[data-edit-task-id="${CSS.escape(id)}"]`);
    const selectedPriorityButtons = document.querySelectorAll(`[data-edit-priority-id="${CSS.escape(id)}"].is-selected`);
    const title = input ? input.value.trim() : "";
    const priority = taskPriorityFromTags(
      Array.from(selectedPriorityButtons, (button) => button.dataset.editPriority)
    );
    if (!title) {
      if (input) {
        input.focus();
      }
      return;
    }

    if (title === task.title && priority === getTaskPriority(task)) {
      cancelEditTaskTitle();
      return;
    }

    await runDataAction(async () => {
      await invokeCommand("update_task_details", {
        id,
        title,
        priority,
        updatedAt: new Date().toISOString(),
      });
      state.editingTaskId = null;
      state.isEditingTask = false;
      await refreshTasks();
    }, "修改任务失败。");
  }

  async function moveTaskToDate(id, plannedDate, errorMessage) {
    cancelDeleteTask();
    const task = state.tasks.find((item) => item.id === id);
    if (task && isTaskCompleted(task)) {
      await restoreTaskToDate(id, plannedDate, errorMessage);
      return;
    }

    await runDataAction(async () => {
      await patchTaskDate(id, plannedDate);
      await refreshTasks();
    }, errorMessage);
  }

  async function moveTaskToInbox(id) {
    cancelDeleteTask();
    const task = state.tasks.find((item) => item.id === id);
    if (task && isTaskCompleted(task)) {
      await restoreTaskToInbox(id, "移到待安排失败。");
      return;
    }

    await runDataAction(async () => {
      await patchTaskUnscheduled(id);
      await refreshTasks();
    }, "移到待安排失败。");
  }

  async function restoreTaskToDate(id, plannedDate, errorMessage, switchToDate) {
    cancelDeleteTask();
    await runDataAction(async () => {
      await patchTaskSchedule(id, plannedDate);
      await refreshTasks();
      if (switchToDate) {
        selectDate(switchToDate);
      }
    }, errorMessage);
  }

  async function restoreTaskToInbox(id, errorMessage) {
    cancelDeleteTask();
    await runDataAction(async () => {
      await patchTaskSchedule(id, null);
      await refreshTasks();
    }, errorMessage);
  }

  async function restoreCompletedTask(task) {
    cancelDeleteTask();
    await runDataAction(async () => {
      await patchTaskSchedule(task.id, getTaskDate(task));
      await refreshTasks();
    }, "恢复任务失败。");
  }

  async function patchTaskCompleted(id) {
    const timestamp = currentLocalTimestamp();
    await invokeCommand("update_task_status", {
      id,
      status: "done",
      completedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async function patchTaskSchedule(id, plannedDate) {
    await invokeCommand("restore_task_to_schedule", {
      taskId: id,
      plannedDate,
      updatedAt: new Date().toISOString(),
    });
  }

  async function patchTaskDate(id, nextDate) {
    await invokeCommand("move_task_to_date", {
      taskId: id,
      plannedDate: nextDate,
      updatedAt: new Date().toISOString(),
    });
  }

  async function patchTaskUnscheduled(id) {
    await invokeCommand("move_task_to_inbox", {
      taskId: id,
      updatedAt: new Date().toISOString(),
    });
  }

  async function toggleTaskPrioritized(task) {
    cancelDeleteTask();
    await runDataAction(async () => {
      await invokeCommand("update_task_prioritized", {
        id: task.id,
        isPrioritized: !isTaskPrioritized(task),
        updatedAt: new Date().toISOString(),
      });
      await refreshTasks();
    }, "更新任务优先状态失败。");
  }

  function requestDeleteTask(id) {
    clearEdgeIdleTimer();
    state.pendingDeleteTaskId = id;
    state.clearDoneConfirmVisible = false;
    render();
    renderClearDoneConfirm();
  }

  function cancelDeleteTask() {
    if (!state.pendingDeleteTaskId) {
      return;
    }

    state.pendingDeleteTaskId = null;
    render();
    resetEdgeIdleTimer();
  }

  async function confirmDeleteTask(id) {
    await runDataAction(async () => {
      await invokeCommand("delete_task", { id });
      state.pendingDeleteTaskId = null;
      await refreshTasks();
    }, "删除任务失败。");
  }

  function requestClearDoneTasks() {
    clearEdgeIdleTimer();
    state.pendingDeleteTaskId = null;
    state.clearDoneConfirmVisible = true;
    render();
    renderClearDoneConfirm();
  }

  function cancelClearDoneTasks() {
    state.clearDoneConfirmVisible = false;
    renderClearDoneConfirm();
    resetEdgeIdleTimer();
  }

  async function confirmClearDoneTasks() {
    await runDataAction(async () => {
      await invokeCommand("clear_done_tasks", { date: state.selectedDate });
      state.clearDoneConfirmVisible = false;
      await refreshTasks();
    }, "清空已完成任务失败。");
  }

  async function exportTasksJson() {
    elements.exportMessage.textContent = "";
    await runDataAction(async () => {
      const result = await invokeCommand("export_tasks_json");
      elements.exportMessage.textContent = `已导出 ${result.taskCount} 条任务`;
      elements.exportMessage.title = result.filePath;
      await refreshDataInfo();
    }, "导出 JSON 失败。");
  }

  async function runDataAction(action, errorMessage) {
    if (!state.dbReady && errorMessage !== "SQLite 初始化失败，任务暂时无法写入。") {
      showDataError("SQLite 尚未就绪，请重启应用后再试。");
      return;
    }

    setBusy(true);
    clearDataError();
    try {
      await action();
    } catch (error) {
      showDataError(errorMessage);
      console.error(errorMessage, error);
    } finally {
      setBusy(false);
      renderClearDoneConfirm();
    }
  }

  function setBusy(isBusy) {
    state.busy = isBusy;
    renderControls();
  }

  function render() {
    ensureDateFreshOnOpen("render", { render: false });
    const grouped = groupTasks();
    const selectedLabel = formatMonthDay(state.selectedDate);
    const selectedIsToday = isSelectedToday();

    elements.todoCount.textContent = String(grouped.todayTodo.length);
    elements.doneCount.textContent = String(grouped.todayDone.length);
    elements.todayTitle.textContent = selectedIsToday ? "今日任务" : `${selectedLabel}任务`;
    elements.tomorrowTitle.textContent = selectedIsToday ? "明日任务" : "次日任务";
    elements.todayEmpty.textContent = selectedIsToday ? "今天还没有待办。" : `${selectedLabel}还没有待办。`;
    elements.tomorrowEmpty.textContent = selectedIsToday ? "明天还没有安排。" : "次日还没有安排。";
    elements.taskInput.placeholder = selectedIsToday ? "输入今日任务" : `输入${selectedLabel}任务`;

    renderList(elements.todayList, grouped.todayTodo, "today");
    renderList(elements.tomorrowList, grouped.tomorrowTodo, "tomorrow");
    renderList(elements.inboxList, grouped.inboxTodo, "inbox");
    renderList(elements.doneList, grouped.doneTasks, "done");

    elements.todayEmpty.classList.toggle("is-visible", grouped.todayTodo.length === 0);
    elements.tomorrowEmpty.classList.toggle("is-visible", grouped.tomorrowTodo.length === 0);
    elements.inboxEmpty.classList.toggle("is-visible", grouped.inboxTodo.length === 0);
    elements.doneEmpty.classList.toggle("is-visible", grouped.doneTasks.length === 0);

    renderDatePicker();
    renderNewTaskPriorityOptions();
    renderControls();
  }

  function groupTasks() {
    const selected = state.selectedDate;
    const next = nextDate(selected);
    const todoTasks = state.tasks.filter((task) => !isTaskCompleted(task));
    const doneTasks = getSelectedDoneTasks();
    const todayTodo = todoTasks.filter((task) => shouldShowInIncompleteForSelectedDate(task, selected));

    return {
      todayTodo: sortTasksByPriority(todayTodo),
      tomorrowTodo: sortTasksByPriority(todoTasks.filter((task) => plannedDate(task) === next)),
      inboxTodo: sortTasksByPriority(todoTasks.filter(isInboxTask)),
      doneTasks,
      todayDone: doneTasks,
    };
  }

  function sortTasksByPriority(tasks) {
    return tasks
      .map((task, index) => ({ task, index }))
      .sort((left, right) => {
        const prioritizedDelta = Number(isTaskPrioritized(right.task)) - Number(isTaskPrioritized(left.task));
        if (prioritizedDelta !== 0) {
          return prioritizedDelta;
        }

        const rankDelta = priorityRank(left.task) - priorityRank(right.task);
        if (rankDelta !== 0) {
          return rankDelta;
        }

        const createdDelta = taskCreatedTimestamp(left.task) - taskCreatedTimestamp(right.task);
        return createdDelta === 0 ? left.index - right.index : createdDelta;
      })
      .map((entry) => entry.task);
  }

  function getSelectedDoneTasks() {
    const selected = state.selectedDate;
    return state.tasks.filter((task) => shouldShowInCompletedForSelectedDate(task, selected));
  }

  function shouldShowInIncompleteForSelectedDate(task, selectedDate, today = todayDate()) {
    if (isTaskCompleted(task)) {
      return false;
    }

    const taskDate = getTaskDate(task);
    if (!taskDate) {
      return false;
    }

    if (isTodaySelected(selectedDate, today)) {
      return taskDate <= today;
    }

    return taskDate === selectedDate;
  }

  function shouldShowInCompletedForSelectedDate(task, selectedDate) {
    if (!isTaskCompleted(task)) {
      return false;
    }

    const completedDate = getTaskCompletedDate(task);
    if (completedDate) {
      return completedDate === selectedDate;
    }

    return isTaskForDate(task, selectedDate);
  }

  function isTaskForDate(task, date) {
    return getTaskDate(task) === date;
  }

  function isInboxTask(task) {
    return isTaskUnscheduled(task);
  }

  function isTaskUnscheduled(task) {
    return !getTaskDate(task);
  }

  function plannedDate(task) {
    return getTaskDate(task);
  }

  function renderControls() {
    const doneTasks = getSelectedDoneTasks();
    const selectedIsToday = isSelectedToday();
    elements.addButton.disabled = state.busy || !state.dbReady;
    elements.taskInput.disabled = state.busy || !state.dbReady;
    elements.priorityOptions.forEach((button) => {
      button.disabled = state.busy || !state.dbReady;
    });
    elements.prioritizedOption.disabled = state.busy || !state.dbReady;
    elements.windowModeButton.disabled = state.windowModeBusy;
    elements.clearDoneButton.disabled = state.busy || !state.dbReady || doneTasks.length === 0;
    elements.confirmClearDoneButton.disabled = state.busy || !state.dbReady || doneTasks.length === 0;
    elements.cancelClearDoneButton.disabled = state.busy;
    elements.exportButton.disabled = state.busy || !state.dbReady;
    document.querySelectorAll(".task-check, .delete-button, .delete-confirm-button, .task-action, .task-edit-button, .task-edit-save, .task-edit-priority").forEach((button) => {
      button.disabled = state.busy || !state.dbReady;
    });
    document.querySelectorAll(".task-edit-cancel").forEach((button) => {
      button.disabled = state.busy;
    });
    document.querySelectorAll(".task-edit-input").forEach((input) => {
      input.disabled = state.busy || !state.dbReady;
    });
    document.querySelectorAll(".calendar-day").forEach((button) => {
      button.disabled = state.busy;
    });
    elements.goTodayButton.disabled = state.busy || selectedIsToday;
  }

  function renderClearDoneConfirm() {
    elements.clearDoneConfirm.classList.toggle("is-visible", state.clearDoneConfirmVisible);
  }

  function toggleDatePicker() {
    clearEdgeIdleTimer();
    state.datePickerOpen = !state.datePickerOpen;
    if (state.datePickerOpen) {
      state.calendarViewDate = firstDayOfMonth(parseDateInput(state.selectedDate));
    }
    renderDatePicker();
    if (!state.datePickerOpen) {
      resetEdgeIdleTimer();
    }
  }

  function closeDatePicker() {
    if (!state.datePickerOpen) {
      return;
    }

    state.datePickerOpen = false;
    renderDatePicker();
    resetEdgeIdleTimer();
  }

  function moveCalendarMonth(offset) {
    const viewDate = state.calendarViewDate || firstDayOfMonth(parseDateInput(state.selectedDate));
    state.calendarViewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + offset, 1);
    renderDatePicker();
  }

  function selectDate(dateString, options = {}) {
    const realToday = getTodayDateKey();
    const isTodayMode = options.todayMode === true || dateString === realToday;
    state.selectedDate = dateString;
    state.isViewingTodayMode = isTodayMode;
    state.hasManualHistoricalDateSelection = !isTodayMode && options.userInitiated !== false;
    state.calendarViewDate = firstDayOfMonth(parseDateInput(dateString));
    state.datePickerOpen = false;
    state.editingTaskId = null;
    state.isEditingTask = false;
    state.pendingDeleteTaskId = null;
    state.clearDoneConfirmVisible = false;
    render();
    renderClearDoneConfirm();
    resetEdgeIdleTimer();
  }

  function selectToday() {
    selectDate(getTodayDateKey(), { todayMode: true });
  }

  function renderDatePicker() {
    const viewDate = state.calendarViewDate || firstDayOfMonth(parseDateInput(state.selectedDate));
    const today = todayDate();
    const selected = state.selectedDate;
    const markedDates = getCalendarMarkedDates();

    elements.selectedDateText.textContent = formatSelectedDate(selected);
    elements.selectedDateButton.setAttribute("aria-expanded", String(state.datePickerOpen));
    elements.datePicker.classList.toggle("is-visible", state.datePickerOpen);
    elements.goTodayButton.hidden = selected === today;
    elements.calendarTitle.textContent = formatMonthTitle(viewDate);
    elements.calendarGrid.replaceChildren();

    const firstDay = firstDayOfMonth(viewDate);
    const daysInMonth = new Date(firstDay.getFullYear(), firstDay.getMonth() + 1, 0).getDate();
    const leadingBlanks = (firstDay.getDay() + 6) % 7;
    const fragment = document.createDocumentFragment();

    for (let index = 0; index < leadingBlanks; index += 1) {
      const blank = document.createElement("span");
      blank.className = "calendar-blank";
      fragment.appendChild(blank);
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateString = formatDateInput(new Date(firstDay.getFullYear(), firstDay.getMonth(), day));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "calendar-day";
      button.textContent = String(day);
      button.disabled = state.busy;
      button.setAttribute("aria-label", formatSelectedDate(dateString));
      if (dateString === today) {
        button.classList.add("is-today");
      }
      if (markedDates.has(dateString)) {
        button.classList.add("has-tasks");
      }
      if (dateString === selected) {
        button.classList.add("is-selected");
        button.setAttribute("aria-current", "date");
      }
      button.addEventListener("click", () => selectDate(dateString));
      fragment.appendChild(button);
    }

    elements.calendarGrid.appendChild(fragment);
  }

  function getCalendarMarkedDates() {
    const dates = new Set();
    state.tasks.forEach((task) => {
      const taskDate = getTaskDate(task);
      const completedDate = getTaskCompletedDate(task);
      if (taskDate) {
        dates.add(taskDate);
      }
      if (completedDate) {
        dates.add(completedDate);
      }
    });
    return dates;
  }

  function renderDataStatus() {
    elements.dataStatus.textContent = state.dbReady ? "本地 SQLite 已启用" : "SQLite 未就绪";
    if (state.dataInfo && state.dataInfo.databasePath) {
      elements.databasePath.textContent = state.dataInfo.databasePath;
      elements.databasePath.title = state.dataInfo.databasePath;
    } else {
      elements.databasePath.textContent = "数据库路径暂不可用";
      elements.databasePath.removeAttribute("title");
    }
    renderControls();
  }

  function renderList(listElement, tasks, section) {
    listElement.replaceChildren();

    const fragment = document.createDocumentFragment();
    tasks.forEach((task) => {
      fragment.appendChild(createTaskElement(task, section));
    });

    listElement.appendChild(fragment);
  }

  function createTaskElement(task, section) {
    const completed = isTaskCompleted(task);
    const item = document.createElement("li");
    item.className = "task-item";
    item.dataset.taskId = task.id;
    if (completed) {
      item.classList.add("is-done");
    }
    if (!completed && isTaskPrioritized(task)) {
      item.classList.add("is-prioritized");
    }

    const checkButton = document.createElement("button");
    checkButton.type = "button";
    checkButton.className = "task-check";
    checkButton.setAttribute("aria-label", completed ? "取消完成" : "标记完成");
    checkButton.setAttribute("aria-pressed", String(completed));
    checkButton.disabled = state.busy || !state.dbReady;
    if (completed) {
      checkButton.classList.add("is-done");
    }
    checkButton.addEventListener("click", () => toggleTask(task.id));

    const titleWrap = document.createElement("div");
    titleWrap.className = "task-copy";

    const titleRow = document.createElement("div");
    titleRow.className = "task-title-row";

    if (state.editingTaskId === task.id && !completed) {
      titleRow.classList.add("is-editing");
      titleRow.appendChild(createInlineEditForm(task));
      titleWrap.appendChild(titleRow);
    } else {
      const title = document.createElement("span");
      title.className = "task-title";
      title.textContent = task.title;
      titleRow.appendChild(title);
      createTaskPriorityBadges(task).forEach((badge) => titleRow.appendChild(badge));

      if (!completed && section !== "done") {
        titleRow.appendChild(createInlineEditButton(task.id));
      }

      const actions = document.createElement("div");
      actions.className = "task-actions";
      appendTaskActions(actions, task, section);

      titleWrap.append(titleRow, createTaskCreatedMeta(task), actions);
    }

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-button";
    deleteButton.setAttribute("aria-label", "删除任务");
    deleteButton.textContent = "×";
    deleteButton.disabled = state.busy || !state.dbReady;
    deleteButton.addEventListener("click", () => requestDeleteTask(task.id));

    item.append(checkButton, titleWrap, deleteButton);

    if (state.pendingDeleteTaskId === task.id) {
      const confirm = document.createElement("div");
      confirm.className = "delete-confirm task-delete-confirm";

      const copy = document.createElement("div");
      const heading = document.createElement("strong");
      heading.textContent = "确认删除？";
      const message = document.createElement("span");
      message.textContent = "删除后不会进入已完成记录。";
      copy.append(heading, message);

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "mini-button secondary delete-confirm-button";
      cancelButton.textContent = "取消";
      cancelButton.disabled = state.busy || !state.dbReady;
      cancelButton.addEventListener("click", cancelDeleteTask);

      const confirmButton = document.createElement("button");
      confirmButton.type = "button";
      confirmButton.className = "mini-button danger delete-confirm-button";
      confirmButton.textContent = "删除";
      confirmButton.disabled = state.busy || !state.dbReady;
      confirmButton.addEventListener("click", () => confirmDeleteTask(task.id));

      confirm.append(copy, cancelButton, confirmButton);
      item.appendChild(confirm);
    }

    return item;
  }

  function appendTaskActions(actions, task, section) {
    if (section === "done") {
      const next = nextDate(state.selectedDate);
      const nextLabel = isSelectedToday() ? "明天" : "次日";
      actions.appendChild(createActionButton("代办", "恢复为当前日期代办", () => restoreTaskToDate(task.id, state.selectedDate, "恢复任务失败。")));
      actions.appendChild(createActionButton(nextLabel, `恢复到${nextLabel}代办`, () => restoreTaskToDate(task.id, next, `移到${nextLabel}失败。`, next)));
      actions.appendChild(createActionButton("待安排", "恢复到待安排", () => restoreTaskToInbox(task.id, "移到待安排失败。")));
      return;
    }

    actions.appendChild(createPriorityToggleButton(task));

    if (section !== "tomorrow") {
      const nextLabel = isSelectedToday() ? "明天" : "次日";
      actions.appendChild(createActionButton(nextLabel, `延后到${nextLabel}`, () => moveTaskToTomorrow(task.id)));
    }

    if (section !== "today") {
      actions.appendChild(createActionButton("今日", "移到今日", () => moveTaskToToday(task.id)));
    }

    if (section !== "inbox") {
      actions.appendChild(createActionButton("待安排", "移到待安排", () => moveTaskToInbox(task.id)));
    }
  }

  function createInlineEditButton(id) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-edit-button";
    button.setAttribute("aria-label", "修改任务");
    button.textContent = "修改";
    button.disabled = state.busy || !state.dbReady;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      startEditTaskTitle(id);
    });
    return button;
  }

  function createInlineEditForm(task) {
    const form = document.createElement("div");
    form.className = "task-edit-form";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "task-edit-input";
    input.maxLength = 120;
    input.value = task.title;
    input.dataset.editTaskId = task.id;
    input.setAttribute("aria-label", "修改任务内容");
    input.disabled = state.busy || !state.dbReady;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveEditTaskTitle(task.id);
      }

      if (event.key === "Escape") {
        event.preventDefault();
        cancelEditTaskTitle();
      }
    });

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "task-edit-save";
    saveButton.textContent = "保存";
    saveButton.disabled = state.busy || !state.dbReady;
    saveButton.addEventListener("click", (event) => {
      event.stopPropagation();
      saveEditTaskTitle(task.id);
    });

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "task-edit-cancel";
    cancelButton.textContent = "取消";
    cancelButton.disabled = state.busy;
    cancelButton.addEventListener("click", (event) => {
      event.stopPropagation();
      cancelEditTaskTitle();
    });

    form.append(input, saveButton, cancelButton);
    form.appendChild(createInlinePriorityPicker(task));
    return form;
  }

  function createInlinePriorityPicker(task) {
    const picker = document.createElement("div");
    picker.className = "task-edit-priority-row";
    picker.setAttribute("role", "group");
    picker.setAttribute("aria-label", "修改任务类型");

    const currentPriority = getTaskPriority(task);
    const hint = document.createElement("span");
    hint.className = "task-edit-priority-hint";
    hint.textContent = "标签可多选，不选即常规";
    picker.appendChild(hint);

    TASK_PRIORITY_TAGS.forEach((priority) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "task-edit-priority";
      button.textContent = TASK_PRIORITY_LABELS[priority];
      button.dataset.editPriority = priority;
      button.dataset.editPriorityId = task.id;
      button.disabled = state.busy || !state.dbReady;
      const selected = taskPriorityHasTag(currentPriority, priority);
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const optionSelected = !button.classList.contains("is-selected");
        button.classList.toggle("is-selected", optionSelected);
        button.setAttribute("aria-pressed", String(optionSelected));
      });
      picker.appendChild(button);
    });

    return picker;
  }

  function createTaskPriorityBadges(task) {
    return taskPriorityTags(getTaskPriority(task)).map((priority) => {
      const badge = document.createElement("span");
      badge.className = `task-priority-badge is-${priority}`;
      badge.textContent = TASK_PRIORITY_LABELS[priority];
      return badge;
    });
  }

  function createTaskCreatedMeta(task) {
    const meta = document.createElement("span");
    meta.className = "task-meta";
    meta.textContent = formatTaskCreatedAt(task && task.createdAt);
    return meta;
  }

  function createPriorityToggleButton(task) {
    const active = isTaskPrioritized(task);
    const button = createActionButton(
      "优先",
      active ? "取消优先排序" : "设为最高优先排序",
      () => toggleTaskPrioritized(task)
    );
    button.classList.toggle("is-priority-active", active);
    button.setAttribute("aria-pressed", String(active));
    return button;
  }

  function createActionButton(label, ariaLabel, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-action";
    button.setAttribute("aria-label", ariaLabel);
    button.textContent = label;
    button.disabled = state.busy || !state.dbReady;
    button.addEventListener("click", handler);
    return button;
  }

  function renderRecentSummaries() {
    elements.recentList.replaceChildren();

    const fragment = document.createDocumentFragment();
    state.summaries.forEach((summary) => {
      const item = document.createElement("li");
      item.className = "summary-item";

      const date = document.createElement("span");
      date.textContent = formatSummaryDate(summary.date);

      const counts = document.createElement("strong");
      counts.textContent = `完成 ${summary.completedCount}，延后 ${summary.carriedCount}`;

      item.append(date, counts);
      fragment.appendChild(item);
    });

    elements.recentList.appendChild(fragment);
    elements.recentEmpty.classList.toggle("is-visible", state.summaries.length === 0);
  }

  function showDataError(message) {
    elements.dataError.textContent = message;
    elements.dataError.classList.add("is-visible");
  }

  function clearDataError() {
    elements.dataError.textContent = "";
    elements.dataError.classList.remove("is-visible");
  }

  function normalizeTaskPriority(priority) {
    return TASK_PRIORITIES.includes(priority) ? priority : "normal";
  }

  function taskPriorityTags(priority) {
    const normalized = normalizeTaskPriority(priority);
    if (normalized === "urgent_important") {
      return ["urgent", "important"];
    }
    return TASK_PRIORITY_TAGS.includes(normalized) ? [normalized] : [];
  }

  function taskPriorityFromTags(tags) {
    const selected = new Set(Array.from(tags).filter((tag) => TASK_PRIORITY_TAGS.includes(tag)));
    if (selected.has("urgent") && selected.has("important")) {
      return "urgent_important";
    }
    if (selected.has("urgent")) {
      return "urgent";
    }
    if (selected.has("important")) {
      return "important";
    }
    return "normal";
  }

  function toggleTaskPriorityTag(priority, tag) {
    const selected = new Set(taskPriorityTags(priority));
    if (selected.has(tag)) {
      selected.delete(tag);
    } else {
      selected.add(tag);
    }
    return taskPriorityFromTags(selected);
  }

  function taskPriorityHasTag(priority, tag) {
    return taskPriorityTags(priority).includes(tag);
  }

  function getTaskPriority(task) {
    return normalizeTaskPriority(task && task.priority);
  }

  function priorityRank(task) {
    return TASK_PRIORITY_RANK[getTaskPriority(task)];
  }

  function isTaskPrioritized(task) {
    return Boolean(task && task.isPrioritized === true);
  }

  function taskCreatedTimestamp(task) {
    const timestamp = Date.parse(task && task.createdAt);
    return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
  }

  function isTaskCompleted(task) {
    if (!task) {
      return false;
    }

    const status = typeof task.status === "string" ? task.status.toLowerCase() : "";
    if (status === "done" || status === "completed" || status === "finished") {
      return true;
    }

    if (task.completed === true || task.done === true || task.finished === true) {
      return true;
    }

    if (getTaskCompletedAt(task)) {
      return true;
    }

    return false;
  }

  function getTaskCompletedAt(task) {
    return firstNonEmptyString(
      task && task.completedAt,
      task && task.completedDate,
      task && task.finishedAt,
      task && task.doneAt
    );
  }

  function getTaskCompletedDate(task) {
    return normalizeDateString(getTaskCompletedAt(task));
  }

  function getTaskDate(task) {
    return normalizeDateString(firstNonEmptyString(
      task && task.plannedDate,
      task && task.date,
      task && task.taskDate,
      task && task.targetDate,
      task && task.scheduledDate,
      task && task.planDate
    ));
  }

  function firstNonEmptyString(...values) {
    const value = values.find((item) => typeof item === "string" && item.trim());
    return value ? value.trim() : null;
  }

  function normalizeDateString(value) {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }

    const dateString = value.trim().slice(0, 10);
    return isValidDateString(dateString) ? dateString : null;
  }

  function clearSavedSelectedDate() {
    // Selected date is session-only now; stale persisted values must not win over real today.
    localStorage.removeItem(SELECTED_DATE_STORAGE_KEY);
  }

  function refreshTodayState() {
    const previousToday = state.lastKnownTodayDate;
    const realToday = getTodayDateKey();
    state.lastKnownTodayDate = realToday;

    return {
      previousToday,
      realToday,
      todayChanged: previousToday !== realToday,
    };
  }

  function ensureDateFreshOnOpen(reason, options = {}) {
    const before = {
      todayKey: state.lastKnownTodayDate,
      selectedDateKey: state.selectedDate,
      followTodayMode: state.isViewingTodayMode,
      manualHistoricalDate: state.hasManualHistoricalDateSelection,
    };
    const todayState = refreshTodayState();
    const shouldAutoReturnToToday =
      options.allowAutoToday === true &&
      !state.hasManualHistoricalDateSelection &&
      state.selectedDate !== todayState.realToday;
    const shouldUseToday =
      options.forceToday === true ||
      state.isViewingTodayMode ||
      shouldAutoReturnToToday;

    let selectedDateChanged = false;
    if (shouldUseToday) {
      state.isViewingTodayMode = true;
      state.hasManualHistoricalDateSelection = false;
    }

    if (shouldUseToday && state.selectedDate !== todayState.realToday) {
      state.selectedDate = todayState.realToday;
      state.isViewingTodayMode = true;
      state.calendarViewDate = firstDayOfMonth(parseDateInput(todayState.realToday));
      state.editingTaskId = null;
      state.isEditingTask = false;
      state.pendingDeleteTaskId = null;
      state.clearDoneConfirmVisible = false;
      selectedDateChanged = true;
    }

    if (isTodaySelected(state.selectedDate, todayState.realToday)) {
      state.isViewingTodayMode = true;
    }

    logDateFreshness(reason, {
      before,
      after: {
        todayKey: todayState.realToday,
        selectedDateKey: state.selectedDate,
        followTodayMode: state.isViewingTodayMode,
        manualHistoricalDate: state.hasManualHistoricalDateSelection,
      },
      forceToday: options.forceToday === true,
      allowAutoToday: options.allowAutoToday === true,
      selectedDateChanged,
      todayChanged: todayState.todayChanged,
    });

    if (options.render !== false && (selectedDateChanged || todayState.todayChanged)) {
      render();
      renderClearDoneConfirm();
    }

    return selectedDateChanged || todayState.todayChanged;
  }

  function logDateFreshness(reason, info) {
    if (!reason || reason === "render") {
      return;
    }

    if (!info.forceToday && !info.selectedDateChanged && !info.todayChanged) {
      return;
    }

    console.info("[worknote:date-refresh]", {
      reason,
      forceToday: info.forceToday,
      allowAutoToday: info.allowAutoToday,
      before: info.before,
      after: info.after,
      selectedDateChanged: info.selectedDateChanged,
      todayChanged: info.todayChanged,
    });
  }

  function loadEdgeSide() {
    const saved = localStorage.getItem(EDGE_SIDE_STORAGE_KEY);
    return saved === "left" ? "left" : "right";
  }

  function loadEdgeTabY() {
    const saved = Number(localStorage.getItem(EDGE_TAB_Y_STORAGE_KEY));
    return Number.isFinite(saved) && saved >= 0 ? saved : null;
  }

  function isSelectedToday() {
    return isTodaySelected(state.selectedDate);
  }

  function isTodaySelected(dateString, today = todayDate()) {
    return dateString === today;
  }

  function formatSelectedDate(dateString) {
    const date = parseDateInput(dateString);
    const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(date);
    const label = `${date.getMonth() + 1}月${date.getDate()}日 ${weekday}`;
    return dateString === getTodayDateKey() ? `${label} · 今天` : label;
  }

  function getTodayDateKey() {
    return formatDateInput(new Date());
  }

  function todayDate() {
    return getTodayDateKey();
  }

  function nextDate(dateString) {
    return addDays(dateString, 1);
  }

  function addDays(dateString, days) {
    const date = parseDateInput(dateString);
    date.setDate(date.getDate() + days);
    return formatDateInput(date);
  }

  function parseDateInput(dateString) {
    if (!isValidDateString(dateString)) {
      return new Date();
    }

    const [year, month, day] = dateString.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function firstDayOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  function isValidDateString(dateString) {
    if (typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      return false;
    }

    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    );
  }

  function formatDateInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function currentLocalTimestamp() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${formatTimezoneOffset(date)}`;
  }

  function formatTimezoneOffset(date) {
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absoluteMinutes = Math.abs(offsetMinutes);
    const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
    const minutes = String(absoluteMinutes % 60).padStart(2, "0");
    return `${sign}${hours}:${minutes}`;
  }

  function formatMonthTitle(date) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }

  function formatMonthDay(dateString) {
    const date = parseDateInput(dateString);
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function formatTaskCreatedAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "时间未知";
    }

    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}年${month}月${day}日 ${hours}:${minutes}`;
  }

  function formatSummaryDate(date) {
    const parts = date.split("-");
    if (parts.length !== 3) {
      return date;
    }

    return `${Number(parts[1])}月${Number(parts[2])}日`;
  }

  function handleAppVisible(reason, options = {}) {
    ensureDateFreshOnOpen(reason, {
      forceToday: options.forceToday === true,
      allowAutoToday: true,
    });
    syncWindowMode();
    if (state.dbReady) {
      ensureDailyBackup();
    }
  }

  function scheduleDateRefreshCheck() {
    if (!state.dateRefreshTimerId) {
      state.dateRefreshTimerId = window.setInterval(() => {
        handleDateRefreshTick("date-refresh-timer");
      }, DATE_REFRESH_INTERVAL_MS);
    }

    STARTUP_DATE_REFRESH_DELAYS_MS.forEach((delayMs) => {
      window.setTimeout(() => {
        handleDateRefreshTick(`startup-date-settle-${delayMs}ms`);
      }, delayMs);
    });
  }

  function handleDateRefreshTick(reason) {
    ensureDateFreshOnOpen(reason, { allowAutoToday: true });
    if (state.dbReady) {
      ensureDailyBackup();
    }
  }

  function bindEvents() {
    const resetOnActivity = () => {
      if (state.isEdgeCollapsed || state.isPointerInsideExpandedWindow) {
        return;
      }

      resetEdgeIdleTimer();
    };
    ["mousemove", "mousedown", "click", "keydown", "input", "wheel", "touchstart"].forEach((eventName) => {
      document.addEventListener(eventName, resetOnActivity, { passive: true });
    });
    document.body.addEventListener("mouseenter", () => {
      state.isPointerInsideExpandedWindow = state.windowMode === "floating" && !state.isEdgeCollapsed;
      clearEdgeIdleTimer();
    });
    document.body.addEventListener("mouseleave", () => {
      state.isPointerInsideExpandedWindow = false;
      scheduleEdgeCollapse(EDGE_MOUSELEAVE_COLLAPSE_DELAY_MS);
    });
    document.addEventListener("compositionstart", () => {
      state.isComposingText = true;
      clearEdgeIdleTimer();
    });
    document.addEventListener("compositionend", () => {
      state.isComposingText = false;
      resetEdgeIdleTimer();
    });
    document.addEventListener("focusin", (event) => {
      if (isBlockingInputElement(event.target)) {
        clearEdgeIdleTimer();
      } else {
        resetEdgeIdleTimer();
      }
    });
    document.addEventListener("focusout", (event) => {
      if (isInputLike(event.target)) {
        window.setTimeout(resetEdgeIdleTimer, 0);
      }
    });
    elements.edgeLogoTab.addEventListener("pointerdown", startEdgeTabPointer);
    elements.edgeLogoTab.addEventListener("pointerenter", focusEdgeWindow);
    elements.edgeLogoTab.addEventListener("mouseenter", focusEdgeWindow);
    elements.edgeLogoTab.addEventListener("pointermove", moveEdgeTabPointer);
    elements.edgeLogoTab.addEventListener("pointerup", finishEdgeTabPointer);
    elements.edgeLogoTab.addEventListener("pointercancel", cancelEdgeTabPointer);
    elements.edgeLogoTab.addEventListener("mousedown", startEdgeTabMouse);
    document.addEventListener("mousemove", moveEdgeTabMouse);
    document.addEventListener("mouseup", finishEdgeTabMouse);
    elements.edgeLogoTab.addEventListener("click", () => {
      if (isEdgeTabActive() && !state.edgeDrag) {
        expandEdgeWindow();
      }
    });
    elements.edgeLogoTab.addEventListener("keydown", (event) => {
      if (!isEdgeTabActive() || (event.key !== "Enter" && event.key !== " ")) {
        return;
      }

      event.preventDefault();
      expandEdgeWindow();
    });
    elements.selectedDateButton.addEventListener("click", toggleDatePicker);
    elements.prevMonthButton.addEventListener("click", () => moveCalendarMonth(-1));
    elements.nextMonthButton.addEventListener("click", () => moveCalendarMonth(1));
    elements.goTodayButton.addEventListener("click", selectToday);
    elements.addButton.addEventListener("click", addTask);
    elements.prioritizedOption.addEventListener("click", toggleNewTaskPrioritized);
    elements.priorityOptions.forEach((button) => {
      button.addEventListener("click", () => selectNewTaskPriority(button.dataset.taskPriority));
    });
    elements.taskInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        addTask();
      }
    });
    elements.clearDoneButton.addEventListener("click", requestClearDoneTasks);
    elements.confirmClearDoneButton.addEventListener("click", confirmClearDoneTasks);
    elements.cancelClearDoneButton.addEventListener("click", cancelClearDoneTasks);
    elements.exportButton.addEventListener("click", exportTasksJson);
    elements.windowModeButton.addEventListener("click", toggleWindowMode);

    if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === "function") {
      window.__TAURI__.event.listen("window-mode-changed", (event) => {
        applyWindowModeInfo(event.payload);
        ensureDateFreshOnOpen("window-mode-changed", { allowAutoToday: true });
      });
      window.__TAURI__.event.listen(WINDOW_SHOWN_EVENT, () => {
        handleAppVisible(WINDOW_SHOWN_EVENT);
      });
      window.__TAURI__.event.listen(WINDOW_FOCUSED_EVENT, () => {
        handleAppVisible(WINDOW_FOCUSED_EVENT);
      });
    }

    window.addEventListener("focus", () => {
      handleAppVisible("focus");
    });
    document.addEventListener("click", (event) => {
      if (!state.datePickerOpen || elements.datePickerWrap.contains(event.target)) {
        return;
      }

      closeDatePicker();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        handleAppVisible("visibilitychange");
      }
    });
    document.addEventListener("DOMContentLoaded", () => {
      handleAppVisible("DOMContentLoaded");
    });
  }

  function init() {
    clearSavedSelectedDate();
    ensureDateFreshOnOpen("init", { forceToday: true, render: false });
    state.calendarViewDate = firstDayOfMonth(parseDateInput(state.selectedDate));
    bindEvents();
    render();
    renderRecentSummaries();
    renderClearDoneConfirm();
    renderDataStatus();
    initializeWindowMode();
    scheduleDailyBackupCheck();
    scheduleDateRefreshCheck();
    initializeData().then(() => {
      ensureDateFreshOnOpen("init-complete", { allowAutoToday: true });
      elements.taskInput.focus();
    });
  }

  init();
})();
