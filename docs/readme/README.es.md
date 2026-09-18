<div align="center">

<a href="https://www.dureai.dev/">
  <img src="../../public/readme/dure-logo.png" alt="Dure" width="88" height="88" />
</a>

# Dure

### Tú diriges.<br>Tus agentes trabajan juntos.

Un **espacio de trabajo de código abierto para agentes de programación con IA**.<br>
Coordina Claude Code, Codex y Pi entre proyectos y hosts SSH, con worktrees dedicados y revisión de código integrada.

**[Descargar para macOS](https://www.dureai.dev/download/mac/)** &nbsp;·&nbsp; [Sitio web](https://www.dureai.dev/) &nbsp;·&nbsp; [Documentación (inglés)](https://docs.dureai.dev/en/introduction) &nbsp;·&nbsp; [X](https://x.com/hebbianai_) &nbsp;·&nbsp; [Discord](https://discord.gg/aTuRV6DXhb)

<sub>Apple Silicon · Usa tus CLI de agentes de programación y tus cuentas habituales</sub>

[English](../../README.md) · [한국어](README.ko.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · **Español** · [Français](README.fr.md) · [Português](README.pt.md)

<br>

<a href="https://www.dureai.dev/#hero-film">
  <img src="../../public/readme/workspace-tour.webp" alt="Dure con Claude Code, Codex, Pi y una shell en seis paneles, con proyectos y sesiones en Spaces" width="960" />
</a>

**[▶ Descubre Dure en 29 segundos](https://www.dureai.dev/#hero-film)** · [Descargar MP4](https://raw.githubusercontent.com/hebbianai/dure/main/public/readme/workspace-tour.mp4)

<sub>Grabación de la aplicación nativa con CLI de agentes reales en un proyecto de ejemplo.<br>La lista de issues de GitHub usa datos de demostración. Se grabó una compilación de desarrollo; la versión descargada puede diferir.</sub>

</div>

<sub>Los enlaces a la documentación de esta traducción llevan a la versión en inglés.</sub>

## Cuatro formas de avanzar

### Agentes en paralelo, worktrees separados

Inicia un agente con **⌘N** o desde un issue de GitHub. Elige su proyecto y proveedor, y asigna un worktree y una rama de Git propios a cada tarea de edición independiente.

[Empieza tareas en paralelo →](https://docs.dureai.dev/en/first-parallel-workflow)

<a href="https://docs.dureai.dev/en/first-parallel-workflow">
  <img src="../../public/readme/start-agent.png" alt="Elige la tarea, el proveedor y la opción de worktree dedicado." width="880" />
</a>

<sub>Elige la tarea, el proveedor y la opción de worktree dedicado.</sub>

### Spaces para trabajo local y por SSH

Agrupa proyectos y sesiones en Spaces. Divide paneles, mueve pestañas y abre ventanas independientes mientras mantienes a la vista el trabajo local y por SSH.

[Spaces y paneles →](https://docs.dureai.dev/en/spaces-and-panes) · [Configurar SSH](https://docs.dureai.dev/en/remote-and-ssh)

<a href="https://docs.dureai.dev/en/spaces-and-panes">
  <img src="../../public/readme/pane-arrangement.png" alt="Organiza los paneles de agentes activos en un proyecto de ejemplo." width="880" />
</a>

<sub>Organiza los paneles de agentes activos en un proyecto de ejemplo.</sub>

### Revisión de código junto a la conversación

Inspecciona los diffs locales, incluidos los cambios sin commit y los archivos nuevos. Comenta un archivo o una línea, envía los comentarios al agente asociado y revisa la siguiente versión antes de integrar el trabajo.

[Revisión y comentarios →](https://docs.dureai.dev/en/review-and-feedback)

<a href="https://docs.dureai.dev/en/review-and-feedback">
  <img src="../../docs/public/images/diff-review.png" alt="Inspecciona el diff de un proyecto de ejemplo antes de añadir comentarios." width="880" />
</a>

<sub>Inspecciona el diff de un proyecto de ejemplo antes de añadir comentarios.</sub>

### Ejecuciones, horarios y coordinación de agentes

Lanza tareas y programa trabajo recurrente con la CLI de Dure. Las integraciones CLI y MCP permiten intercambiar mensajes de progreso, solicitudes de decisión e informes de finalización entre personas y agentes.

```sh
dure run --provider codex --worktree readme-review \
  "Review the README against the code. Do not change files."
dure ls
```

[Ejecuciones y horarios de la CLI →](https://docs.dureai.dev/en/cli-and-automation) · [Mensajes y decisiones](https://docs.dureai.dev/en/orchestration)

## Agentes compatibles

**Claude Code · Codex · Pi · OpenCode · Gemini CLI · Kimi Code**

Usa las CLI de agentes que ya tienes instaladas y tus cuentas de proveedor actuales. El acceso a modelos, las suscripciones y los cargos de uso siguen siendo responsabilidad de cada proveedor.

Claude Code, Codex, OpenCode y Pi tienen integraciones de chat estructurado cuando el entorno instalado las admite. Las funciones de terminal, historial, reanudación y cuentas varían según el proveedor. [Consulta las capacidades por proveedor →](https://docs.dureai.dev/en/providers)

## Instalación y estado por plataforma

| Plataforma | Disponibilidad actual |
| --- | --- |
| macOS · Apple Silicon | [Descarga oficial](https://www.dureai.dev/download/mac/) |
| Windows | Código disponible; validación nativa de escritorio e instalador público pendientes. |
| Linux | Código disponible; validación nativa de escritorio e instalador público pendientes. |
| iOS | Código disponible; validación en dispositivos y distribución oficial pendientes. |
| Android | Código disponible; validación en dispositivos y distribución oficial pendientes. |

Para compilar desde el código y consultar la cobertura de verificación, ve a la [guía de desarrollo por plataforma](../../CONTRIBUTING.md#platforms).

### Empieza en tu Mac

1. **[Descarga Dure para macOS](https://www.dureai.dev/download/mac/)** en un Mac con Apple Silicon. Abre la imagen de disco y mueve la app a **Aplicaciones**.
2. Instala al menos una CLI de agente compatible e inicia sesión. Sigue la [guía de instalación](https://docs.dureai.dev/en/install), incluidas las indicaciones de seguridad de macOS.
3. Abre en Dure un proyecto Git que conozcas. Pulsa **⌘N** y empieza con una tarea pequeña.

<details>
<summary>Algunos límites que conviene conocer</summary>

- **Los worktrees separan archivos, no permisos.** No son entornos de aislamiento de seguridad: no aíslan credenciales, procesos ni acceso a la red. Los cambios aún pueden entrar en conflicto al integrarlos.
- **El host debe seguir activo.** Las sesiones gestionadas pueden continuar sin la ventana de la app mientras el proceso host y el equipo sigan en ejecución. Un reinicio termina el proceso original; la recuperación crea otro.
- **La revisión sigue siendo necesaria.** Comprueba los permisos del agente, los cambios y las pruebas antes de aceptar el trabajo. El cambio de cuenta y las sesiones remotas tienen límites según el proveedor y el entorno de ejecución.

[Sesiones y recuperación](https://docs.dureai.dev/en/session-model) · [SSH](https://docs.dureai.dev/en/remote-and-ssh) · [Seguridad del trabajo](https://docs.dureai.dev/en/current-limits)

</details>

### Instalación para desarrollar desde el código

En un Mac con Apple Silicon, instala Git, Xcode Command Line Tools, la [versión fijada de Node](../../.node-version) y [rustup](https://rustup.rs/). Después ejecuta:

```sh
git clone https://github.com/hebbianai/dure.git
cd dure
corepack enable
pnpm install --frozen-lockfile
pnpm app:dev
```

Esto prepara el entorno de ejecución y la CLI e inicia la aplicación de desarrollo. La primera compilación nativa puede tardar. Consulta la [guía de instalación para desarrollo](../../CONTRIBUTING.md#development-installation) para instalar la `.app` local, configurar las herramientas y trabajar en Windows/Linux/iOS/Android.

## Alcance del código abierto

Copyright (C) 2026 [Hebbian AI](../../COPYRIGHT).

El código propio de escritorio, móvil, entorno de ejecución (incluido Hmux), CLI y servicios publicado aquí está disponible bajo [GNU GPL solo versión 3 (GPL-3.0-only)](../../LICENSE); los componentes de terceros conservan sus licencias y avisos. Puedes usar, modificar y redistribuir el código conforme a esas licencias. Al distribuir binarios cubiertos por GPL, debes proporcionar el código fuente correspondiente (Corresponding Source) según GPLv3. Las versiones publicadas anteriormente bajo MIT siguen disponibles bajo esos términos.

[TRADEMARK.md](../../TRADEMARK.md) explica el uso del nombre, logotipo e iconos de Dure, y la distinción entre las compilaciones comunitarias y las oficiales de Hebbian AI.

La licencia del código no incluye acceso a los servicios operados. Las claves de firma, las credenciales de despliegue y los registros comerciales y operativos confidenciales permanecen privados.

## Contribuir

Consulta la [guía de contribución](../../CONTRIBUTING.md) y el [código de conducta](../../CODE_OF_CONDUCT.md), o [informa de un error o propone una función](https://github.com/hebbianai/dure/issues/new/choose). Para vulnerabilidades, utiliza el canal privado de la [política de seguridad](../../SECURITY.md). Las guías de contribución y comunidad están disponibles por ahora en inglés.

- **Notas de versión:** [GitHub Releases](https://github.com/hebbianai/hebbian-releases/releases)
- **Privacidad y telemetría:** [Privacidad y telemetría](https://docs.dureai.dev/en/privacy-and-telemetry)
- **Comunidad:** [Discord](https://discord.gg/aTuRV6DXhb)
- **Novedades:** [X · @hebbianai_](https://x.com/hebbianai_)

---

<div align="center">

**Tú diriges. Tus agentes trabajan juntos.**

[Descargar Dure](https://www.dureai.dev/download/mac/) · [Leer la documentación](https://docs.dureai.dev/en/introduction) · [dureai.dev](https://www.dureai.dev/) · [X](https://x.com/hebbianai_) · [Discord](https://discord.gg/aTuRV6DXhb)

</div>
