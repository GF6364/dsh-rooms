/**
 * dsh-rooms — 跨会话协作插件（浏览器端）
 *
 * 工作区里每个会话都是房间，没有「加入」这回事。
 * 面板只干一件事：分组。卡片上只有名字和「干活中」，点一下不动作，拖进组就归组，
 * 拖到「未分组」就取消归组。颜色一律用宿主主题 token（--dsw-alias-*）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-rooms',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const PANEL_ID = 'rooms';
    const API = '/dsh-rooms/api';
    const ZH = !String((navigator.languages && navigator.languages[0]) || navigator.language || 'zh').toLowerCase().startsWith('en');

    const T = {
      panel: ZH ? '房间' : 'Rooms',
      title: ZH ? '房间' : 'Rooms',
      hint: ZH ? '拖动卡片换组，拖到「未分组」就取消归组' : 'Drag a card into a group; drag to Ungrouped to clear it',
      ungrouped: ZH ? '未分组' : 'Ungrouped',
      ungroupedHint: ZH ? '没分组的房间放这儿，不是一组' : 'Rooms without a group; not a group itself',
      refresh: ZH ? '刷新' : 'Refresh',
      loading: ZH ? '加载中…' : 'Loading…',
      error: ZH ? '出错了' : 'Error',
      working: ZH ? '干活中' : 'working',
      newGroup: ZH ? '新分组名字' : 'New group name',
      create: ZH ? '新建分组' : 'New group',
      rename: ZH ? '改名' : 'Rename',
      remove: ZH ? '删除' : 'Delete',
      confirmRemove: ZH ? '真的删？' : 'Delete?',
      save: ZH ? '保存' : 'Save',
      cancelEdit: ZH ? '取消' : 'Cancel',
      dropHere: ZH ? '拖到这里换组' : 'Drop here',
      tabGroups: ZH ? '分组' : 'Groups',
      tabConfig: ZH ? '配置' : 'Settings',
      idleLabel: ZH ? '多久没动静就提醒' : 'Remind after idle',
      idleHelp: ZH ? '派出去之后，这么多分钟没回报、会话也没在写盘，就发一条提醒给派活的那个会话。填 0 关掉。' : 'If a room reports nothing and writes nothing for this long, the dispatcher gets a reminder. 0 disables.',
      minuteUnit: ZH ? '分钟' : 'min',
      saved: ZH ? '存好了' : 'Saved',
      nameNote: ZH ? '房间名直接用工作区里的会话标题，这里改不了；要改名去工作区改。' : 'Room names come from the workspace session title; rename it there.',
      roomUnit: ZH ? '个房间' : 'rooms',
    };

    async function call(method, payload) {
      const response = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload ?? {}),
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`);
      }
      if (body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`);
      return body.data;
    }

    const FONT = '14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    const C = {
      text: 'var(--dsw-alias-label-primary, #1b1d1f)',
      muted: 'var(--dsw-alias-label-secondary, #6b7280)',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,.4))',
      surface: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
      surface2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1))',
      err: 'var(--dsw-alias-state-error-primary, #e5534b)',
    };

    const S = {
      page: {
        display: 'flex', flexDirection: 'column', gap: 14, padding: '20px 24px',
        height: '100%', overflow: 'auto', boxSizing: 'border-box', font: FONT,
        color: C.text, background: 'var(--dsw-alias-bg-base, transparent)',
      },
      header: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      h1: { margin: 0, fontSize: 18, fontWeight: 600 },
      muted: { color: C.muted, fontSize: 12 },
      input: {
        borderRadius: 8, padding: '6px 10px', fontSize: 13, fontFamily: 'inherit',
        color: C.text, background: C.surface2, border: `1px solid ${C.border}`,
      },
      button: {
        borderRadius: 8, padding: '6px 12px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
        border: `1px solid ${C.borderStrong}`, background: C.surface, color: C.text,
      },
      small: {
        borderRadius: 6, padding: '2px 8px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
        border: `1px solid ${C.border}`, background: 'transparent', color: C.muted,
      },
      tabs: { display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}` },
      tab: {
        padding: '6px 14px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
        border: 'none', borderBottom: '2px solid transparent', background: 'transparent', color: C.muted,
      },
      tabOn: { color: C.text, borderBottom: `2px solid var(--dsw-alias-brand-primary, #1f6feb)`, fontWeight: 600 },
      group: {
        border: '1px dashed transparent', borderRadius: 12, padding: 12,
        display: 'flex', flexDirection: 'column', gap: 10,
      },
      groupDragging: { border: `1px dashed ${C.borderStrong}` },
      groupOver: { borderColor: 'var(--dsw-alias-brand-primary, #1f6feb)', background: 'rgba(31,111,235,.06)' },
      groupHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      groupTitle: { fontWeight: 600, fontSize: 14 },
      grid: { display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' },
      card: {
        border: `1px solid ${C.border}`, borderRadius: 10, padding: 10,
        display: 'flex', alignItems: 'center', gap: 8,
        background: C.surface, color: C.text, cursor: 'grab',
        userSelect: 'none', WebkitUserSelect: 'none',
        outline: 'none', WebkitTapHighlightColor: 'transparent',
      },
      cardRun: { cursor: 'default', borderColor: 'var(--dsw-alias-brand-primary, #1f6feb)' },
      title: { fontWeight: 600, fontSize: 14, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chipRun: {
        fontSize: 11, padding: '0 6px', borderRadius: 999, lineHeight: '18px', flex: 'none',
        color: '#fff', background: 'var(--dsw-alias-brand-primary, #1f6feb)',
      },
      err: { color: C.err, fontSize: 13 },
      configCard: {
        border: `1px solid ${C.border}`, borderRadius: 12, padding: 16,
        display: 'flex', flexDirection: 'column', gap: 10, background: C.surface,
      },
    };

    function RoomPage() {
      const [data, setData] = useState(null);
      const [tab, setTab] = useState('groups');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [groupName, setGroupName] = useState('');
      const [editing, setEditing] = useState(null); // { id, title }
      const [confirmDelete, setConfirmDelete] = useState(null);
      const [dragOverGroup, setDragOverGroup] = useState(null);
      const [dragging, setDragging] = useState(false);
      const [idleDraft, setIdleDraft] = useState('');
      const [savedNote, setSavedNote] = useState('');
      const draggingRef = useRef(null);

      const load = useCallback(async () => {
        try {
          const next = await call('list');
          setData(next);
          setIdleDraft((draft) => (draft === '' ? String(next.idleTimeoutMinutes) : draft));
          setError('');
        } catch (err) {
          setError(String(err.message || err));
        }
      }, []);

      useEffect(() => {
        void load();
        const timer = setInterval(() => { void load(); }, 6000);
        return () => clearInterval(timer);
      }, [load]);

      // 拖到窗口外面松手时，card 上的 dragend 不一定回得来，这里兜底复位
      useEffect(() => {
        const stop = () => { draggingRef.current = null; setDragging(false); setDragOverGroup(null); };
        window.addEventListener('dragend', stop);
        window.addEventListener('drop', stop);
        return () => {
          window.removeEventListener('dragend', stop);
          window.removeEventListener('drop', stop);
        };
      }, []);

      const act = useCallback(async (method, payload, after) => {
        setBusy(true);
        try {
          await call(method, payload);
          await load();
          if (after) await after();
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
        }
      }, [load]);

      const rooms = data?.rooms ?? [];
      const groups = data?.groups ?? [];
      const ungroupedCount = rooms.filter((room) => (room.groupId ?? null) === null).length;
      const roomsOf = (groupId) => rooms.filter((room) => (room.groupId ?? null) === groupId);

      const card = (room) => h('div', {
        key: room.id,
        draggable: !room.running,
        onDragStart: (event) => {
          draggingRef.current = room.id;
          event.dataTransfer.setData('text/plain', room.id);
          event.dataTransfer.effectAllowed = 'move';
          setDragging(true);
        },
        onDragEnd: () => {
          draggingRef.current = null;
          setDragging(false);
          setDragOverGroup(null);
        },
        style: { ...S.card, ...(room.running ? S.cardRun : null) },
      },
        h('span', { style: S.title, title: room.name }, room.name),
        room.running ? h('span', { style: S.chipRun }, T.working) : null,
      );

      const groupBlock = (groupId, title, subtitle) => {
        const list = roomsOf(groupId);
        const isEditing = groupId && editing?.id === groupId;
        const bucketKey = groupId ?? 'ungrouped';
        return h('div', {
          key: bucketKey,
          style: {
            ...S.group,
            ...(dragging ? S.groupDragging : null),
            ...(dragOverGroup === bucketKey ? S.groupOver : null),
          },
          onDragOver: (event) => { event.preventDefault(); setDragOverGroup(bucketKey); },
          onDragLeave: () => setDragOverGroup(null),
          onDrop: (event) => {
            event.preventDefault();
            const roomId = event.dataTransfer.getData('text/plain') || draggingRef.current;
            setDragOverGroup(null);
            setDragging(false);
            if (roomId) void act('moveRoom', { room: roomId, group: groupId ?? null });
          },
        },
          h('div', { style: S.groupHead },
            isEditing
              ? h(React.Fragment, null,
                  h('input', {
                    style: { ...S.input, width: 180 }, value: editing.title, autoFocus: true,
                    onChange: (event) => setEditing({ id: groupId, title: event.target.value }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        void act('renameGroup', { group: groupId, title: editing.title }, () => setEditing(null));
                      }
                      if (event.key === 'Escape') setEditing(null);
                    },
                  }),
                  h('button', { style: S.small, onClick: () => void act('renameGroup', { group: groupId, title: editing.title }, () => setEditing(null)) }, T.save),
                  h('button', { style: S.small, onClick: () => setEditing(null) }, T.cancelEdit),
                )
              : h('span', { style: S.groupTitle }, title),
            h('span', { style: S.muted }, `${list.length}`),
            subtitle ? h('span', { style: S.muted }, subtitle) : null,
            h('span', { style: { flex: 1 } }),
            groupId
              ? h(React.Fragment, null,
                  h('button', { style: S.small, onClick: () => setEditing({ id: groupId, title }) }, T.rename),
                  h('button', {
                    style: { ...S.small, ...(confirmDelete === groupId ? { color: C.err, borderColor: C.err } : null) },
                    onClick: () => {
                      if (confirmDelete === groupId) {
                        setConfirmDelete(null);
                        void act('deleteGroup', { group: groupId });
                      } else {
                        setConfirmDelete(groupId);
                      }
                    },
                  }, confirmDelete === groupId ? T.confirmRemove : T.remove),
                )
              : (dragging ? h('span', { style: S.muted }, T.dropHere) : null),
          ),
          list.length === 0
            ? (dragging ? h('div', { style: S.muted }, T.dropHere) : null)
            : h('div', { style: S.grid }, list.map(card)),
        );
      };

      const groupsTab = () => h(React.Fragment, null,
        h('div', { style: S.header },
          h('span', { style: S.muted }, T.hint),
          h('span', { style: { flex: 1 } }),
          h('input', {
            style: S.input, placeholder: T.newGroup, value: groupName,
            onChange: (event) => setGroupName(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && groupName.trim()) {
                const title = groupName.trim();
                setGroupName('');
                void act('createGroup', { title });
              }
            },
          }),
          h('button', {
            style: S.button, disabled: !groupName.trim(),
            onClick: () => {
              const title = groupName.trim();
              if (!title) return;
              setGroupName('');
              void act('createGroup', { title });
            },
          }, T.create),
          h('button', { style: S.button, onClick: () => void load() }, T.refresh),
        ),
        data === null
          ? h('div', { style: S.muted }, T.loading)
          : h(React.Fragment, null,
              groups.map((group) => groupBlock(group.id, group.title)),
              groupBlock(null, T.ungrouped, T.ungroupedHint),
            ),
      );

      const configTab = () => h('div', { style: S.configCard },
        h('div', { style: S.title }, T.idleLabel),
        h('div', { style: S.muted }, T.idleHelp),
        h('div', { style: S.header },
          h('input', {
            style: { ...S.input, width: 90 }, type: 'number', min: 0, max: 1440,
            value: idleDraft,
            onChange: (event) => { setIdleDraft(event.target.value); setSavedNote(''); },
          }),
          h('span', { style: S.muted }, T.minuteUnit),
          h('button', {
            style: S.button, disabled: busy,
            onClick: () => void act('setConfig', { idleTimeoutMinutes: Number(idleDraft) }, async () => setSavedNote(T.saved)),
          }, T.save),
          savedNote ? h('span', { style: S.muted }, savedNote) : null,
        ),
        h('div', { style: { borderTop: `1px solid ${C.border}`, margin: '6px 0' } }),
        h('div', { style: S.title }, T.nameNote),
      );

      return h('div', { style: S.page },
        h('div', { style: S.header },
          h('h1', { style: S.h1 }, T.title),
          h('span', { style: S.muted }, `${rooms.length} ${T.roomUnit}${ungroupedCount > 0 ? ` · ${T.ungrouped} ${ungroupedCount}` : ''}`),
        ),
        h('div', { style: S.tabs },
          h('button', { style: { ...S.tab, ...(tab === 'groups' ? S.tabOn : null) }, onClick: () => { setTab('groups'); setSavedNote(''); } }, T.tabGroups),
          h('button', { style: { ...S.tab, ...(tab === 'config' ? S.tabOn : null) }, onClick: () => { setTab('config'); setSavedNote(''); } }, T.tabConfig),
        ),
        error ? h('div', { style: S.err }, `${T.error}: ${error}`) : null,
        tab === 'config' ? configTab() : groupsTab(),
      );
    }

    function RoomIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
        h('path', { d: 'M3 9h18' }),
        h('circle', { cx: 7.5, cy: 6.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 10.5, cy: 6.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M8 13h8M8 16.5h5' }),
      );
    }

    return {
      name: 'rooms',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 18, label: () => T.panel },
          RoomIcon,
        ));
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID },
          RoomPage,
        ));
      },
    };
  },
});
