import {loadImage} from "tfw/core/assets"
import {Loop} from "tfw/core/clock"
import {refEquals} from "tfw/core/data"
import {dim2, rect} from "tfw/core/math"
import {Mutable, Value} from "tfw/core/react"
import {Disposer} from "tfw/core/util"
import {TypeScriptGameEngine} from "tfw/engine/typescript/game"
import {ThreeRenderEngine} from "tfw/engine/typescript/three/render"
import {CannonPhysicsEngine} from "tfw/engine/typescript/cannon/physics"
import {HTMLHost} from "tfw/ui/element"
import {UI} from "tfw/ui/ui"

import {createUIConfig} from "./ui/config"
import {createUIModel} from "./ui/model"
import {UIStyles, UITheme} from "./ui/theme"

const root = document.getElementById("root")
if (!root) throw new Error("No root?")
const rootSize = Value.deriveValue(
  refEquals,
  dispatch => {
    let size = dim2.fromValues(root.clientWidth, root.clientHeight)
    const listener = () => {
      const oldSize = size
      size = dim2.fromValues(root.clientWidth, root.clientHeight)
      dispatch(size, oldSize)
    }
    window.addEventListener("resize", listener)
    return () => window.removeEventListener("resize", listener)
  },
  () => dim2.fromValues(root.clientWidth, root.clientHeight),
)

const disposer = new Disposer()
document.body.addEventListener("unload", () => disposer.dispose())

const gameBounds = Mutable.local(rect.create())
const gameEngine = new TypeScriptGameEngine(root, gameBounds)
disposer.add(gameEngine)
disposer.add(new ThreeRenderEngine(gameEngine))
disposer.add(new CannonPhysicsEngine(gameEngine))

const ui = new UI(UITheme, UIStyles, {resolve: loadImage})
const uiRoot = ui.createRoot(createUIConfig(rootSize), createUIModel(rootSize, gameEngine, ui))
const host = new HTMLHost(root)
host.addRoot(uiRoot)

const canvas = uiRoot.findTaggedChild("canvas")!

const loop = new Loop()
disposer.add(loop.clock.onEmit(clock => {
  host.update(clock)
  if (!rect.eq(gameBounds.current, canvas.bounds)) gameBounds.update(rect.clone(canvas.bounds))
  gameEngine.update(clock)
}))
loop.start()
disposer.add(() => loop.stop())
