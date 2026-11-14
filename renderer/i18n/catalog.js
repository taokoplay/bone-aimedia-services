/* Stable catalog IDs select display copy without modifying provider data. */
(() => {
  'use strict';
  const A = window.AIMedia;
  A.i18n.register('catalog', {
    en: {
      dreaminaName: 'Dreamina',
      openaiName: 'OpenAI image generation',
      minimaxName: 'MiniMax',
      xiaomiName: 'Xiaomi MiMo',
      comfyuiName: 'ComfyUI',
      libtvName: 'LibTV',
      dreaminaDescription: 'Configure the local CLI and image/video models. Model names are configuration suggestions; actual support depends on the current CLI.',
      openaiDescription: 'For image and media generation only, without chat or general text conversation. An accessible model catalog does not verify generation support.',
      minimaxDescription: 'Query cloud media models and account voices, supplemented by the builtin catalog. Query results do not verify generation support.',
      xiaomiDescription: 'Configure Xiaomi speech models and voices; the default voice is mimo_default. Connection checks only read the model catalog.',
      comfyuiDescription: 'Connect to self-hosted ComfyUI, read system and node information, and check API workflow node types. Media capabilities depend on the actual workflow.',
      libtvDescription: 'Connect through host MCP/OAuth. This page saves the service entry; remote tools are provided by the authorized MCP service.',
      cliMissing: 'Dreamina CLI was not found. Install it or specify its path below',
      loggedOut: 'Not logged in to Dreamina CLI',
      unknownLogin: 'The command ran but returned no valid status',
    },
    'zh-CN': {
      dreaminaName: '即梦 Dreamina',
      openaiName: 'OpenAI 图片生成',
      minimaxName: 'MiniMax',
      xiaomiName: '小米 MiMo',
      comfyuiName: 'ComfyUI',
      libtvName: 'LibTV',
      dreaminaDescription: '配置本机 CLI 与图片／视频模型。模型名称仅供配置参考，实际支持范围以当前 CLI 为准。',
      openaiDescription: '仅用于图片和媒体生成，不提供聊天或通用文本对话能力。模型目录可访问不代表生成能力已验证。',
      minimaxDescription: '查询云端媒体模型和账号音色，内置目录作为补充；查询结果不代表生成能力已验证。',
      xiaomiDescription: '配置小米语音合成模型与音色，默认音色 mimo_default。连接检查只读取模型目录。',
      comfyuiDescription: '连接自托管 ComfyUI，读取系统与节点信息，核对 API 工作流的节点类型。媒体能力取决于实际工作流。',
      libtvDescription: '通过宿主 MCP/OAuth 连接。当前页面保存服务入口，实际远程工具由已授权的 MCP 服务提供。',
      cliMissing: '未找到 dreamina CLI，请确认已安装或在下方指定路径',
      loggedOut: '尚未登录即梦 CLI',
      unknownLogin: '已执行但未返回有效状态',
    }
  });
  const t = A.i18n.scope('catalog');
  const names = { dreamina: 'dreaminaName', openai: 'openaiName', minimax: 'minimaxName', xiaomi: 'xiaomiName', comfyui: 'comfyuiName', libtv: 'libtvName' };
  const descriptions = { dreamina: 'dreaminaDescription', openai: 'openaiDescription', minimax: 'minimaxDescription', xiaomi: 'xiaomiDescription', comfyui: 'comfyuiDescription', libtv: 'libtvDescription' };
  A.providerName = provider => provider && Object.hasOwn(names, provider.id) ? t(names[provider.id]) : provider?.name || provider?.id || '';
  A.providerDescription = provider => provider && Object.hasOwn(descriptions, provider.id) ? t(descriptions[provider.id]) : provider?.description || '';
  A.dreaminaStatusText = status => {
    const keys = { cliMissing: 'cliMissing', loggedOut: 'loggedOut', unknown: 'unknownLogin' };
    return status && Object.hasOwn(keys, status.state) ? t(keys[status.state]) : status?.message;
  };
})();
