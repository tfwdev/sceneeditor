import {
  Mesh, Object3D, PlaneBufferGeometry, Scene, ShaderMaterial, Vector2, WebGLRenderTarget,
} from "three"

import {Color} from "tfw/core/color"
import {Bounds, Plane, Ray, clamp, quat, vec3} from "tfw/core/math"
import {Mutable, Value} from "tfw/core/react"
import {Noop, NoopRemover} from "tfw/core/util"
import {GameObject, Hover, Transform} from "tfw/engine/game"
import {property} from "tfw/engine/meta"
import {TypeScriptComponent, registerConfigurableType} from "tfw/engine/typescript/game"
import {ThreeObjectComponent, ThreeRenderEngine} from "tfw/engine/typescript/three/render"
import {Keyboard} from "tfw/input/keyboard"

import {
  EDITOR_HIDE_FLAG, NONINTERACTIVE_LAYER_FLAG, OUTLINE_LAYER, SpaceEditConfig, applyEdit, selection,
} from "./ui/model"

let outlineCount = 0
let outlineRemover = NoopRemover

let renderTarget :WebGLRenderTarget|undefined

const postScene = new Scene()
postScene.autoUpdate = false

let postMaterial :ShaderMaterial|undefined

// get these before we need them so that the Keyboard instance is created and listening
const controlKeyState = Keyboard.instance.getKeyState(17)
const shiftKeyState = Keyboard.instance.getKeyState(16)

class Selector extends TypeScriptComponent {
  readonly groupHovered = Mutable.local(false)

  private _outlineObject? :Object3D
  private _intersectionToCenter? :vec3

  awake () {
    this._disposer.add(
      Value
        .join3(
          this.gameObject
            .getProperty<ThreeObjectComponent|undefined>("hoverable")
            .switchMap(hoverable => {
              if (!hoverable) return Value.constant<[number, Object3D|undefined]>([0, undefined])
              return Value.join2(hoverable.hovers.sizeValue, hoverable.objectValue)
            }),
          this.groupHovered,
          selection.hasValue(this.gameObject.id),
        )
        .onValue(([[hovered, object], groupHovered, selected]) => {
          if (object && (hovered || groupHovered || selected)) this._setOutline(object, selected)
          else this._clearOutline()
        })
    )
  }

  onPointerDown (identifier :number, hover :Hover) {
    if (controlKeyState.current) {
      if (selection.has(this.gameObject.id)) selection.delete(this.gameObject.id)
      else selection.add(this.gameObject.id)

    } else if (!selection.has(this.gameObject.id)) {
      selection.clear()
      selection.add(this.gameObject.id)
    }
    const intersection = vec3.create()
    if (this._getXZPlaneIntersection(hover, intersection)) {
      this._intersectionToCenter = vec3.subtract(intersection, this._getCenter(), intersection)
    } else {
      this._intersectionToCenter = undefined
    }
  }

  onPointerDrag (identifier :number, hover :Hover) {
    if (!this._intersectionToCenter) return
    const intersection = vec3.create()
    if (!this._getXZPlaneIntersection(hover, intersection)) return
    const oldCenter = this._getCenter()
    const newCenter = vec3.add(intersection, intersection, this._intersectionToCenter)
    if (!shiftKeyState.current) {
      const delta = vec3.subtract(vec3.create(), newCenter, oldCenter)
      vec3.round(delta, delta)
      vec3.add(newCenter, oldCenter, delta)
    }
    const edit :SpaceEditConfig = {}
    if (selection.has(this.gameObject.id)) {
      for (const id of selection) {
        const gameObject = this.gameEngine.gameObjects.require(id)
        const offset = vec3.subtract(vec3.create(), gameObject.transform.position, oldCenter)
        edit[id] = {
          transform: {position: vec3.add(offset, offset, newCenter)},
        }
      }
    } else {
      edit[this.gameObject.id] = {
        transform: {position: newCenter},
      }
    }
    applyEdit({edit})
  }

  private _setOutline (object :Object3D, selected :boolean) {
    this._clearOutline()
    this._outlineObject = object
    object.traverse(node => {
      if (!(node instanceof Mesh)) return
      node.layers.enable(OUTLINE_LAYER)
      let previousOpacity = 0
      node.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
        previousOpacity = material.opacity
        material.opacity = selected ? 0.8 : 0.4
      }
      node.onAfterRender = (renderer, scene, camera, geometry, material, group) => {
        material.opacity = previousOpacity
      }
    })
    if (++outlineCount === 1) {
      const threeRenderEngine = this.gameEngine.renderEngine as ThreeRenderEngine
      const renderer = threeRenderEngine.renderer
      const size = renderer.getDrawingBufferSize(new Vector2())
      if (!renderTarget) {
        renderTarget = new WebGLRenderTarget(size.x, size.y)
        postMaterial = new ShaderMaterial({
          vertexShader: `
            varying vec2 v_UV;
            void main(void) {
              v_UV = uv;
              gl_Position = vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            uniform sampler2D texture;
            uniform vec2 pixelSize;
            varying vec2 v_UV;
            void main(void) {
              // we use a half-pixel offset so that we can take advantage of linear interpolation
              // to sample four pixels at once
              vec2 offset = pixelSize * 1.5;
              vec4 left = vec4(
                texture2D(texture, v_UV + vec2(-offset.x, -offset.y)).a,
                texture2D(texture, v_UV + vec2(-offset.x, 0.0)).a,
                texture2D(texture, v_UV + vec2(-offset.x, offset.y)).a,
                texture2D(texture, v_UV + vec2(0.0, -offset.y)).a
              );
              vec4 right = vec4(
                texture2D(texture, v_UV + vec2(0.0, offset.y)).a,
                texture2D(texture, v_UV + vec2(offset.x, -offset.y)).a,
                texture2D(texture, v_UV + vec2(offset.x, 0.0)).a,
                texture2D(texture, v_UV + vec2(offset.x, offset.y)).a
              );
              vec4 leftSigns = sign(left);
              vec4 rightSigns = sign(right);
              float sum = dot(left, vec4(1.0)) + dot(right, vec4(1.0));
              float count = dot(leftSigns, vec4(1.0)) + dot(rightSigns, vec4(1.0));
              float base = texture2D(texture, v_UV).a;
              gl_FragColor = vec4(vec3(sum / count), sign(count) * (1.0 - sign(base)));
            }
          `,
          transparent: true,
          uniforms: {
            texture: {value: renderTarget.texture},
            pixelSize: {value: new Vector2()},
          },
        })
        postScene.add(new Mesh(new PlaneBufferGeometry(2, 2), postMaterial))
      }
      threeRenderEngine.onAfterRender = (scene, camera) => {
        renderer.getDrawingBufferSize(size)
        renderTarget!.setSize(size.x, size.y)
        renderer.setRenderTarget(renderTarget!)
        renderer.clear()
        const previousLayerMask = camera.layers.mask
        camera.layers.set(OUTLINE_LAYER)
        renderer.render(scene, camera)
        camera.layers.mask = previousLayerMask

        renderer.setRenderTarget(null)
        postMaterial!.uniforms.pixelSize.value.set(2 / size.x, 2 / size.y)
        renderer.render(postScene, camera)
      }
      outlineRemover = () => {
        threeRenderEngine.onAfterRender = undefined
      }
    }
  }

  private _clearOutline () {
    if (!this._outlineObject) return
    this._outlineObject.traverse(node => {
      if (!(node instanceof Mesh)) return
      node.onBeforeRender = node.onAfterRender = Noop
      node.layers.disable(OUTLINE_LAYER)
    })
    this._outlineObject = undefined
    if (--outlineCount === 0) outlineRemover()
  }

  private _getXZPlaneIntersection (hover :Hover, result :vec3) :boolean {
    const activeCamera = this.gameEngine.renderEngine.activeCameras[0]
    if (!activeCamera) return false
    const controller = activeCamera.requireComponent<CameraController>("cameraController")
    return controller.getXZPlaneIntersection(hover, result)
  }

  private _getCenter () :vec3 {
    if (!selection.has(this.gameObject.id)) return vec3.clone(this.transform.position)
    const center = vec3.create()
    for (const id of selection) {
      vec3.add(center, center, this.gameEngine.gameObjects.require(id).transform.position)
    }
    return vec3.scale(center, center, 1 / selection.size)
  }
}
registerConfigurableType("component", undefined, "selector", Selector)

const tmpq = quat.create()
const tmpr = Ray.create()
const tmpv = vec3.create()
const tmpb = Bounds.create()

const xzPlane = Plane.fromValues(0, 1, 0, 0)

const transforms :Transform[] = []
let selectors = new Set<Selector>()
let lastSelectors = new Set<Selector>()

// a scale that's very small, but nonzero (to avoid noninvertible matrices)
const SMALL_SCALE = 0.000001

class CameraController extends TypeScriptComponent {
  @property("vec3") target = vec3.create()
  @property("number") azimuth = 0
  @property("number") elevation = -45
  @property("number") distance = 10

  private _selectRegion? :GameObject
  private _selectStartPosition = vec3.create()

  getXZPlaneIntersection (hover :Hover, result :vec3) :boolean {
    vec3.copy(tmpr.origin, this.transform.position)
    vec3.subtract(tmpr.direction, hover.worldPosition, tmpr.origin)
    vec3.normalize(tmpr.direction, tmpr.direction)
    const distance = Plane.intersectRay(xzPlane, tmpr.origin, tmpr.direction)
    if (!(distance > 0)) return false // could be NaN
    Ray.getPoint(result, tmpr, distance)
    return true
  }

  reset () {
    // @ts-ignore zero does exist
    vec3.zero(this.target)
    this.azimuth = 0
    this.elevation = -45
    this.distance = 10
  }

  awake () {
    const offset = vec3.create()
    this._disposer.add(
      Value
        .join2(
          this.getProperty<vec3>("target"),
          Value.join(
            this.getProperty<number>("azimuth"),
            this.getProperty<number>("elevation"),
            this.getProperty<number>("distance"),
          ),
        )
        .onValue(([target, [azimuth, elevation, distance]]) => {
          quat.fromEuler(this.transform.rotation, elevation, azimuth, 0)
          vec3.transformQuat(offset, vec3.set(offset, 0, 0, distance), this.transform.rotation)
          vec3.add(this.transform.position, target, offset)
        }),
    )
  }

  onPointerDown (identifier :number, hover :Hover) {
    const mouse = this.gameEngine.ctx.hand!.mouse
    if (mouse.getButtonState(0).current && shiftKeyState.current) {
      selection.clear()
      if (!this.getXZPlaneIntersection(hover, this._selectStartPosition)) return
      this._selectRegion = this.gameEngine.createGameObject("select", {
        layerFlags: NONINTERACTIVE_LAYER_FLAG,
        hideFlags: EDITOR_HIDE_FLAG,
        transform: {
          position: this._selectStartPosition,
          localScale: vec3.fromValues(SMALL_SCALE, 1, SMALL_SCALE),
        },
        meshFilter: {
          meshConfig: {type: "cube"},
        },
        meshRenderer: {
          materialConfig: {
            type: "basic",
            color: Color.fromRGB(0.4, 0.4, 0.4),
            transparent: true,
            opacity: 0.125,
          },
        },
      })
    }
  }

  onPointerDrag (identifier :number, hover :Hover) {
    if (this._selectRegion) {
      if (!this.getXZPlaneIntersection(hover, tmpv)) return
      const transform = this._selectRegion.transform
      vec3.add(transform.position, this._selectStartPosition, tmpv)
      vec3.scale(transform.position, transform.localPosition, 0.5)
      vec3.set(
        transform.localScale,
        Math.max(SMALL_SCALE, Math.abs(tmpv[0] - this._selectStartPosition[0])),
        1,
        Math.max(SMALL_SCALE, Math.abs(tmpv[2] - this._selectStartPosition[2])),
      )
      vec3.min(tmpb.min, this._selectStartPosition, tmpv)
      vec3.max(tmpb.max, this._selectStartPosition, tmpv)
      tmpb.min[1] -= 0.5
      tmpb.max[1] += 0.5
      this.gameEngine.renderEngine.overlapBounds(tmpb, ~NONINTERACTIVE_LAYER_FLAG, transforms)
      for (const transform of transforms) {
        const selector = transform.requireComponent<Selector>("selector")
        selector.groupHovered.update(true)
        selectors.add(selector)
      }
      transforms.length = 0
      for (const selector of lastSelectors) {
        if (!selectors.has(selector)) selector.groupHovered.update(false)
      }
      lastSelectors.clear();
      [selectors, lastSelectors] = [lastSelectors, selectors]
      return
    }
    const mouse = this.gameEngine.ctx.hand!.mouse
    if (mouse.getButtonState(0).current) {
      this.azimuth += hover.viewMovement[0] * -180
      this.elevation = clamp(this.elevation + hover.viewMovement[1] * 180, -90, 90)

    } else if (mouse.getButtonState(1).current) {
      this._addToDistance(hover.viewMovement[1] * -20)

    } else {
      vec3.transformQuat(
        tmpv,
        vec3.set(tmpv, -hover.viewMovement[0], 0, hover.viewMovement[1]),
        quat.fromEuler(tmpq, 0, this.azimuth, 0),
      )
      this.target = vec3.scaleAndAdd(tmpv, this.target, tmpv, this.distance)
    }
  }

  onPointerUp (identifier :number) {
    if (this._selectRegion) {
      this._selectRegion.dispose()
      this._selectRegion = undefined

      if (lastSelectors.size > 0) {
        for (const selector of lastSelectors) {
          selector.groupHovered.update(false)
          selection.add(selector.gameObject.name)
        }
        lastSelectors.clear()
      }
    }
  }

  onWheel (identifier :number, hover :Hover, delta :vec3) {
    this._addToDistance(0.5 * Math.sign(delta[1]))
  }

  private _addToDistance (amount :number) {
    this.distance = Math.max(0.5, this.distance + amount)
  }
}
registerConfigurableType("component", undefined, "cameraController", CameraController)
