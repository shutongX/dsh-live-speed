// dsh-live-speed 的界面部分（手写 bundle，无构建步骤）。
// 官方「会话统计」的 TPS 是整段会话的累计平均（decodeTokens / decodeMs），
// 这里在读屏位置另加一个"本轮实时"读数，两者互不影响。
// 实时算法的数据源：chat store 的 legacy.partial（当前正在生成的 step 的 blocks），
// 每秒采样一次文本字符数，取最近 3 秒窗口算字符速率，
// 再乘以「最近几轮 真实 outputTokens / 字符数」的比例换算成 tok/s。
window.__ModuleLoader__.load({
  id: 'dsh-live-speed',
  factory: function (require) {
    var React = require('react');
    var h = React.createElement;

    var PKG = 'dsh-live-speed';
    var SLOT = 'conversation.composer.dock';
    var ENTRY_ID = 'live-speed';
    var ENTRY_ORDER = 2;

    var WINDOW_MS = 3000;
    var TICK_MS = 1000;
    var MIN_SPAN_S = 0.35;
    var CALIBRATION_STEPS = 5;
    // 没有历史可校准时用的经验比例（中英混排大致每字符 0.4~0.6 token）
    var RATIO_FALLBACK = 0.45;
    var EMPTY_NODES = [];
    // 沿用旧读数的最大空档：结算瞬间用得上，会话切换后过期
    var STALE_MS = 10000;
    var warnedNoChat = false;

    var lang = (function () {
      var tag = '';
      try {
        if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) {
          tag = document.documentElement.lang;
        }
      } catch (error) {}
      if (!tag && typeof navigator !== 'undefined') tag = navigator.language || '';
      // 读不到语言标签时按中文处理：DSH 主要用户是中文环境
      return tag === '' || /^zh/i.test(tag) ? 'zh' : 'en';
    })();
    var TEXT = {
      zh: {
        live: '实时',
        last: '上轮',
        liveTip: function (live, turn) {
          return '最近 ' + WINDOW_MS / 1000 + ' 秒约 ' + live + ' tok/s' +
            (turn === null ? '' : '；本轮平均 ' + turn + ' tok/s');
        },
        lastTip: '上一轮回复的实际生成速度（整轮）',
        ratioTip: '估算比例：每字符约 ',
      },
      en: {
        live: 'Live',
        last: 'Last',
        liveTip: function (live, turn) {
          return 'about ' + live + ' tok/s over the last ' + WINDOW_MS / 1000 + 's' +
            (turn === null ? '' : '; this turn averages ' + turn + ' tok/s');
        },
        lastTip: 'Actual generation speed of the previous reply (whole reply)',
        ratioTip: 'Estimated ratio: ',
      },
    };
    var L = TEXT[lang];

    var CSS = [
      '.dlsv-anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
      '.dlsv-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;',
      'color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;',
      'line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;',
      'gap:5px;padding:1px 8px;display:inline-flex}',
      '.dlsv-pill svg{flex:none;width:13px;height:13px}',
      '.dlsv-live{color:var(--dsw-alias-label-secondary)}',
    ].join('');

    function now() {
      return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    }

    function fmt(value) {
      if (!(value > 0)) return '0';
      return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
    }

    /** 统计一组内容块里的可见文本字符数（正文 + 思考），tool-call 不算。 */
    function blockChars(blocks) {
      if (!blocks) return 0;
      var total = 0;
      for (var i = 0; i < blocks.length; i += 1) {
        var block = blocks[i];
        if (!block) continue;
        if (block.kind === 'text' || block.kind === 'reasoning') {
          if (typeof block.text === 'string') total += block.text.length;
        }
      }
      return total;
    }

    function outputTokensOf(node) {
      var usage = node && node.usage;
      var value = usage && typeof usage === 'object' ? usage.outputTokens : null;
      return typeof value === 'number' && isFinite(value) && value > 0 ? value : null;
    }

    /** 用最近几条已完成回复的真实 token 数校准「每字符多少 token」。 */
    function tokensPerChar(nodes) {
      var tokens = 0;
      var chars = 0;
      var steps = 0;
      for (var i = nodes.length - 1; i >= 0 && steps < CALIBRATION_STEPS; i -= 1) {
        var node = nodes[i];
        if (!node || node.kind !== 'assistant') continue;
        var out = outputTokensOf(node);
        if (out === null) continue;
        var c = blockChars(node.blocks);
        if (c <= 0) continue;
        tokens += out;
        chars += c;
        steps += 1;
      }
      return chars > 0 ? tokens / chars : RATIO_FALLBACK;
    }

    /** 最近的、能算出真实速度的已完成回复：outputTokens / 解码时长。 */
    function lastRealSpeed(nodes) {
      for (var i = nodes.length - 1; i >= 0; i -= 1) {
        var node = nodes[i];
        if (!node || node.kind !== 'assistant') continue;
        var timing = node.timing;
        var out = outputTokensOf(node);
        // 缺用量或缺时间戳的步骤（中断、纯工具调用、未上报）跳过，继续往前找，
        // 不要让整条读数因为最后一步没数据就消失。
        if (!timing || out === null) continue;
        if (typeof timing.firstTokenTime !== 'number' || typeof timing.completedTime !== 'number') continue;
        var ms = timing.completedTime - timing.firstTokenTime;
        if (!(ms > 0)) continue;
        return out / (ms / 1000);
      }
      return null;
    }

    function Bolt(props) {
      return h('svg', {
        viewBox: '0 0 16 16',
        'aria-hidden': true,
        style: props && props.muted ? { opacity: 0.5 } : undefined,
      }, h('path', { d: 'M8.9 1 3 9.1h3.8L6.5 15 13 6.5H9.2L8.9 1z', fill: 'currentColor' }));
    }

    function LiveSpeedPill(props) {
      var useChat = props ? props.useChat : undefined;
      // 拿不到 chat store 就不渲染，避免把 slot 条目搞崩
      if (typeof useChat !== 'function') {
        if (!warnedNoChat) {
          warnedNoChat = true;
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[dsh-live-speed] slot props 里没有 useChat，实时速度无法读取');
          }
        }
        return null;
      }

      var partial = useChat(function (state) {
        return state && state.legacy ? state.legacy.partial : undefined;
      });
      var rawNodes = useChat(function (state) {
        return state && state.legacy ? state.legacy.nodes : undefined;
      });
      var nodes = Array.isArray(rawNodes) ? rawNodes : EMPTY_NODES;

      var ratio = React.useMemo(function () { return tokensPerChar(nodes); }, [nodes]);
      var lastSpeed = React.useMemo(function () { return lastRealSpeed(nodes); }, [nodes]);

      var streaming = partial !== null && partial !== undefined;
      var stepKey = streaming ? String(partial.turn) + ':' + String(partial.step) : '';
      var chars = streaming ? blockChars(partial.blocks) : 0;

      var charsRef = React.useRef(chars);
      var samplesRef = React.useRef([]);
      var startRef = React.useRef(0);
      var lastShownRef = React.useRef(null);
      var state = React.useState(0);
      var bump = state[1];

      charsRef.current = chars;

      React.useEffect(function () {
        samplesRef.current = [];
        startRef.current = 0;
        if (!streaming) return undefined;
        var t0 = now();
        startRef.current = t0;
        samplesRef.current = [{ t: t0, c: charsRef.current }];
        var timer = setInterval(function () {
          var t = now();
          var samples = samplesRef.current;
          samples.push({ t: t, c: charsRef.current });
          while (samples.length > 2 && t - samples[0].t > WINDOW_MS) samples.shift();
          bump(function (value) { return value + 1; });
        }, TICK_MS);
        return function () {
          clearInterval(timer);
        };
      }, [stepKey, streaming]);

      var live = null;
      var turn = null;
      if (streaming) {
        var samples = samplesRef.current;
        if (samples.length >= 2) {
          var first = samples[0];
          var last = samples[samples.length - 1];
          var span = (last.t - first.t) / 1000;
          if (span >= MIN_SPAN_S) {
            var rate = (last.c - first.c) / span;
            if (rate > 0) live = rate * ratio;
          }
        }
        if (startRef.current > 0) {
          var elapsed = (now() - startRef.current) / 1000;
          if (elapsed > 0.3) turn = (chars / elapsed) * ratio;
        }
      }

      // 实时值优先；流式刚结束、节点还没结算、这一步没有输出时，退回上一次的读数，
      // 不要因为一瞬间没数据就整条消失。
      var shown = streaming ? (live !== null ? live : turn) : lastSpeed;
      var isLive = streaming;
      if (shown !== null && shown > 0) {
        lastShownRef.current = { value: shown, live: isLive, at: now() };
      } else if (lastShownRef.current !== null && now() - lastShownRef.current.at < STALE_MS) {
        // 只在很短的空档内沿用旧读数；切到别的会话过久后就该隐藏，不显示无关数据
        shown = lastShownRef.current.value;
        isLive = lastShownRef.current.live;
      } else {
        return null;
      }

      if (isLive) {
        return h('span', { className: 'dlsv-anchor' },
          h('span', {
            className: 'dlsv-pill dlsv-live',
            title: L.liveTip(fmt(shown), turn === null ? null : fmt(turn)),
          },
            h(Bolt, null),
            L.live + ' ' + fmt(shown) + ' tok/s'));
      }
      return h('span', { className: 'dlsv-anchor' },
        h('span', {
          className: 'dlsv-pill',
          title: L.lastTip + '；' + L.ratioTip + fmt(ratio * 100) + '%',
        },
          h(Bolt, { muted: true }),
          L.last + ' ' + fmt(shown) + ' tok/s'));
    }

    function injectStyle() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin=' + JSON.stringify(PKG) + ']') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = PKG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        injectStyle();
        ctx.slots.inject(SLOT, function () {
          return ctx.slots.register({
            name: SLOT,
            id: ENTRY_ID,
            order: ENTRY_ORDER,
          }, LiveSpeedPill);
        });
      },
    };
  },
});
