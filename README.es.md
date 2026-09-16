<div align="center">

<a href="https://www.dureai.dev/">
  <img src="./public/readme/dure-logo.png" alt="Dure" width="88" height="88" />
</a>

# Dure

### Tú diriges.<br>Tus agentes trabajan juntos.

Un **Agent Development Environment (ADE)** para tus agentes de programación con IA.<br>
Proyectos, conversaciones, terminales y cambios de código, en un solo espacio de trabajo para macOS.

**[Descargar para macOS](https://www.dureai.dev/download/mac/)** &nbsp;·&nbsp; [Sitio web](https://www.dureai.dev/) &nbsp;·&nbsp; [Documentación (inglés)](https://docs.dureai.dev/en/introduction)

<sub>Apple Silicon · Usa tus CLI de agentes de programación y tus cuentas habituales</sub>

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · **Español** · [Français](README.fr.md) · [Português](README.pt.md)

<br>

<a href="https://www.dureai.dev/#hero-film">
  <img src="./public/readme/workspace-tour.webp" alt="Dure con Claude Code, Codex, Pi y una shell en seis paneles, con proyectos y sesiones en Spaces" width="960" />
</a>

**[▶ Descubre Dure en 29 segundos](https://www.dureai.dev/#hero-film)** · [Descargar MP4](https://raw.githubusercontent.com/hebbianai/dure/main/public/readme/workspace-tour.mp4)

<sub>Grabación de la aplicación nativa con CLI de agentes reales en un proyecto de ejemplo.<br>La lista de issues de GitHub usa datos de demostración. Se grabó una compilación de desarrollo; la versión descargada puede diferir.</sub>

</div>

## Más agentes. Un solo lugar desde el que dirigir.

Lo difícil no es iniciar otro agente. Es saber qué tarea te necesita, qué ha cambiado y qué hacer después.

Dure reúne ese trabajo en un solo lugar. Pon Claude Code junto a Codex y Pi. Sigue las sesiones de distintos proyectos y equipos SSH. Lee las diferencias, envía comentarios y marca el rumbo de la siguiente tarea.

El nombre viene de **두레**, una tradición coreana de trabajo colectivo en comunidades agrícolas. Distintas manos, un trabajo compartido. Tú marcas la dirección.

## De la primera tarea a la revisión final

### 01 — Empieza con un objetivo

Pulsa **⌘N**, describe la tarea y elige un proyecto y un proveedor. Asigna un Git worktree y una rama propios a cada tarea que deba editar archivos de forma independiente. También puedes elegir **Start** en un issue de GitHub para abrir una tarea con el contenido ya rellenado.

### 02 — Organiza tu atención

Divide paneles, mueve pestañas, cambia de escritorio o abre una sesión en su propia ventana. Spaces muestra el trabajo local y por SSH en una misma vista, con indicadores de actividad y cambios para localizar lo que necesita atención.

<table>
<tr>
<td width="50%">
<a href="https://docs.dureai.dev/en/quickstart"><img src="./public/readme/start-agent.png" alt="Diálogo New agent abierto con Command-N, con opciones de tarea, proyecto, proveedor y worktree dedicado" width="460" /></a>
<br><sub>Describe el trabajo. Elige el agente.</sub>
</td>
<td width="50%">
<a href="https://docs.dureai.dev/en/spaces-and-panes"><img src="./public/readme/pane-arrangement.png" alt="Una pestaña de terminal en ejecución se arrastra al área Split Right de Dure" width="460" /></a>
<br><sub>Mueve la vista. Conserva el contexto.</sub>
</td>
</tr>
</table>

### 03 — Revisa y orienta

Inspecciona los cambios locales, incluidos los archivos nuevos y los cambios sin commit. Añade comentarios por línea y envíalos al agente. Comprueba los cambios y los resultados de las pruebas antes de integrar el trabajo: tú decides el siguiente paso.

[Tu primer agente →](https://docs.dureai.dev/en/quickstart) &nbsp; [Tareas en paralelo →](https://docs.dureai.dev/en/first-parallel-workflow) &nbsp; [Revisión y comentarios →](https://docs.dureai.dev/en/review-and-feedback)

## El espacio de trabajo que rodea a tus agentes

| Cuando necesitas… | Dure ofrece… |
| --- | --- |
| Trabajar en tareas independientes | Git worktrees y ramas dedicados, con los archivos de cada tarea separados. |
| Seguir el trabajo en curso | Spaces, paneles divididos, escritorios y ventanas independientes entre proyectos. |
| Volver después de cerrar la app | Reconexión a sesiones gestionadas que siguen activas; un flujo de recuperación distinto para procesos terminados. |
| Trabajar en varios equipos | Proyectos SSH y terminales remotos junto al trabajo local, con pegado de imágenes y transferencia de archivos. |
| Usar tus cuentas habituales | Perfiles por agente y uso informado por el proveedor, donde estén disponibles. |
| Conectar trabajo repetible | Ejecuciones y tareas programadas por CLI; mensajes, solicitudes de decisión e informes de finalización por CLI/MCP. |
| Adaptar el entorno a ti | Temas, tipografía del terminal e interfaz disponible en siete idiomas. |

### Tus herramientas. Tus cuentas.

Usa CLI nativas de agentes de programación como **Claude Code, Codex, Pi, Gemini CLI, OpenCode y Kimi Code**. Dure es un espacio de trabajo, no un modelo ni una suscripción a un proveedor. Las suscripciones y los cargos por uso de los proveedores se pagan por separado.

La compatibilidad del terminal, el historial de conversaciones, las vistas de chat y las herramientas de cuenta varían según el proveedor. [Consulta las capacidades de cada proveedor →](https://docs.dureai.dev/en/providers)

## Empieza en tu Mac

1. **[Descarga Dure para macOS](https://www.dureai.dev/download/mac/)** en un Mac con Apple Silicon. Abre la imagen de disco y mueve la app a **Aplicaciones**.
2. Instala al menos una CLI de agente compatible e inicia sesión. Sigue la [guía de instalación](https://docs.dureai.dev/en/install), incluidas las indicaciones de seguridad de macOS.
3. Abre en Dure un proyecto Git que conozcas. Pulsa **⌘N** y empieza con una tarea pequeña.

Prueba primero esto:

```text
Averigua cómo ejecutar las pruebas de este repositorio.
No modifiques ningún archivo.
Indica los comandos y los archivos que los documentan.
```

### Algunos límites que conviene conocer

- **Los worktrees separan archivos, no permisos.** No son entornos de aislamiento de seguridad: no aíslan credenciales, procesos ni acceso a la red. Los cambios aún pueden entrar en conflicto al integrarlos.
- **El host debe seguir activo.** Las sesiones gestionadas pueden continuar sin la ventana de la app mientras el proceso host y el equipo sigan en ejecución. Un reinicio termina el proceso original; la recuperación crea otro.
- **La revisión sigue siendo necesaria.** Comprueba los permisos del agente, los cambios y las pruebas antes de aceptar el trabajo. El cambio de cuenta y las sesiones remotas tienen límites según el proveedor y el entorno de ejecución.

[Sesiones y recuperación](https://docs.dureai.dev/en/session-model) · [SSH](https://docs.dureai.dev/en/remote-and-ssh) · [Seguridad del trabajo](https://docs.dureai.dev/en/current-limits)

<sub>Los enlaces a la documentación de esta traducción llevan a la versión en inglés.</sub>

## Disponibilidad del código fuente

**Open-source release: TBD. — Publicación como código abierto: por determinar.**

**Licencia: [MIT](LICENSE) · Copyright (c) 2026 Hebbian AI.**

Este es el repositorio público oficial de Dure en GitHub para información y material del producto, y el destino de la futura publicación del código fuente. El código propio de Dure se publicará aquí bajo MIT; los componentes de terceros conservarán sus licencias y avisos de copyright. El código fuente de la aplicación aún no es público y no se ha anunciado una fecha de publicación.

La app se descarga desde el [sitio web](https://www.dureai.dev/download/mac/); este repositorio no es una distribución del código fuente ni una guía para compilarlo.

---

<div align="center">

**Tú diriges. Tus agentes trabajan juntos.**

[Descargar Dure](https://www.dureai.dev/download/mac/) · [Leer la documentación](https://docs.dureai.dev/en/introduction) · [dureai.dev](https://www.dureai.dev/)

</div>
