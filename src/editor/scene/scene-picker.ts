import {
    Engine, Scene, AbstractMesh, TargetCamera, Animation, Mesh,
    PositionGizmo, RotationGizmo, ScaleGizmo, UtilityLayerRenderer, Observer,
    PointerInfo, PointerEventTypes, Vector3, Camera,
    BoundingBoxGizmo, Color3, Quaternion
} from 'babylonjs';

import Editor from '../editor';

import UndoRedo from '../tools/undo-redo';

export enum GizmoType {
    NONE = 0,
    BOUNDING_BOX,
    POSITION,
    ROTATION,
    SCALING
}

export default class ScenePicker {
    // Public members
    public editor: Editor;
    public scene: Scene;
    public canvas: HTMLCanvasElement;

    public gizmosLayer: UtilityLayerRenderer;

    public onPickedMesh: (mesh: AbstractMesh) => void;
    public onUpdateMesh: (mesh: AbstractMesh) => void;

    // Protected members
    protected lastMesh: AbstractMesh = null;
    protected lastClickedMesh: AbstractMesh = null;
    protected lastX: number = 0;
    protected lastY: number = 0;
    
    protected onCanvasPointer: Observer<PointerInfo> = null;
    protected onCanvasBlur: Observer<PointerEvent> = null;
    protected onCanvasFocus: Observer<Engine> = null;

    protected boundingBoxGizmo: BoundingBoxGizmo;
    protected positionGizmo: PositionGizmo;
    protected rotationGizmo: RotationGizmo;
    protected scalingGizmo: ScaleGizmo;
    protected currentGizmo: BoundingBoxGizmo | PositionGizmo | RotationGizmo | ScaleGizmo = null;

    // Private members
    private _enabled: boolean = true;
    private _gizmoType: GizmoType = GizmoType.NONE;

    private _gizmoDelta: number = 0;
    private _gizmoScaleDelta: Vector3 = null;
    private _gizmoPositionDelta: Vector3 = null;
    private _gizmoRotationDelta: Quaternion = null;

    /**
     * Constructor
     * @param editor: the editor reference
     * @param canvas: the canvas to track
     */
    constructor (editor: Editor, scene: Scene, canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.scene = scene;
        this.editor = editor;

        scene.cameras.forEach(c => {
            c.detachControl(canvas);
            c.attachControl(canvas, true);
        });
        scene.meshes.forEach(m => {
            m.metadata = m.metadata || { };
            m.metadata.baseConfiguration = {
                isPickable: m.isPickable
            };
            m.isPickable = true;
        });

        // Gizmos
        this.gizmosLayer = new UtilityLayerRenderer(scene);
        this.gizmosLayer.utilityLayerScene.postProcessesEnabled = false;
        this.gizmosLayer.shouldRender = false;

        // Add events
        this.addEvents();
    }

    /**
     * Returns if the scene picker is enabled
     */
    public get enabled (): boolean {
        return this._enabled;
    }

    /**
     * Sets if the scene picker is enabled
     */
    public set enabled (value: boolean) {
        this._enabled = value;

        if (!value) {
            this.gizmoType = GizmoType.NONE;

            if (this.lastMesh)
                this.lastMesh.showBoundingBox = false;
        }
    }

    /**
     * Sets the gizmo type
     */
    public set gizmoType (value: GizmoType) {
        this._gizmoType = value;

        // Dispose and clear
        this.boundingBoxGizmo && this.boundingBoxGizmo.dispose();
        this.positionGizmo && this.positionGizmo.dispose();
        this.rotationGizmo && this.rotationGizmo.dispose();
        this.scalingGizmo && this.scalingGizmo.dispose();

        this.boundingBoxGizmo = this.positionGizmo = this.rotationGizmo = this.scalingGizmo = null;

        // Create gizmo
        switch (value) {
            case GizmoType.BOUNDING_BOX:
                this.currentGizmo = this.boundingBoxGizmo = new BoundingBoxGizmo(new Color3(1, 1, 1), this.gizmosLayer);
                this.boundingBoxGizmo.rotationSphereSize = 0.25;
                this.boundingBoxGizmo.scaleBoxSize = 0.4;
                break;
            case GizmoType.POSITION: this.currentGizmo = this.positionGizmo = new PositionGizmo(this.gizmosLayer); break;
            case GizmoType.ROTATION: this.currentGizmo = this.rotationGizmo = new RotationGizmo(this.gizmosLayer); break;
            case GizmoType.SCALING: this.currentGizmo = this.scalingGizmo = new ScaleGizmo(this.gizmosLayer); break;
            default: break; // GizmoType.NONE
        }

        // Attach mesh
        this.setGizmoAttachedMesh(this.editor.core.currentSelectedObject);

        // Events
        if (!(this.currentGizmo instanceof BoundingBoxGizmo)) {
            this.currentGizmo.xGizmo.dragBehavior.onDragObservable.add(() => this.onUpdateMesh && this.onUpdateMesh(this.currentGizmo.attachedMesh));
            this.currentGizmo.yGizmo.dragBehavior.onDragObservable.add(() => this.onUpdateMesh && this.onUpdateMesh(this.currentGizmo.attachedMesh));
            this.currentGizmo.zGizmo.dragBehavior.onDragObservable.add(() => this.onUpdateMesh && this.onUpdateMesh(this.currentGizmo.attachedMesh));

            // Undo redo
            this.currentGizmo.xGizmo.dragBehavior.onDragObservable.add(g => this._gizmoDelta += g.delta.x);
            this.currentGizmo.yGizmo.dragBehavior.onDragObservable.add(g => this._gizmoDelta += g.delta.y);
            this.currentGizmo.zGizmo.dragBehavior.onDragObservable.add(g => this._gizmoDelta += g.delta.z);

            this.currentGizmo.xGizmo.dragBehavior.onDragEndObservable.add(_ => this.undoRedo('x'));
            this.currentGizmo.yGizmo.dragBehavior.onDragEndObservable.add(_ => this.undoRedo('y'));
            this.currentGizmo.zGizmo.dragBehavior.onDragEndObservable.add(_ => this.undoRedo('z'));
        }
        else {
            this.currentGizmo.onScaleBoxDragObservable.add(_ => {
                if (this._gizmoScaleDelta === null) {
                    this._gizmoScaleDelta = Vector3.Zero().copyFrom(this.boundingBoxGizmo.attachedMesh.scaling);
                    this._gizmoPositionDelta = Vector3.Zero().copyFrom(this.boundingBoxGizmo.attachedMesh.position);
                }
            });

            this.currentGizmo.onRotationSphereDragObservable.add(_ => {
                if (this._gizmoRotationDelta === null)
                    this._gizmoRotationDelta = new Quaternion().copyFrom(this.boundingBoxGizmo.attachedMesh.rotationQuaternion);
            });

            this.currentGizmo.onScaleBoxDragEndObservable.add(_ => this.undoRedo('boundingbox'));
            this.currentGizmo.onRotationSphereDragEndObservable.add(_ => this.undoRedo('boundingbox'));
        }
    }

    /**
     * Sets the attached mesh for position, rotaiton and scaling gizmos
     * @param mesh the mesh to attach
     */
    public setGizmoAttachedMesh (mesh: AbstractMesh): void {
        if (mesh && !(mesh instanceof AbstractMesh))
            return;
        
        this.boundingBoxGizmo && (this.boundingBoxGizmo.attachedMesh = mesh);
        this.positionGizmo && (this.positionGizmo.attachedMesh = mesh);
        this.rotationGizmo && (this.rotationGizmo.attachedMesh = mesh);
        this.scalingGizmo && (this.scalingGizmo.attachedMesh = mesh);
    }

    /**
     * Adds the events to the canvas
     */
    public addEvents (): void {
        this.onCanvasPointer = this.scene.onPointerObservable.add(ev => {
            switch (ev.type) {
                case PointerEventTypes.POINTERDOWN: this.canvasDown(ev.event); break;
                case PointerEventTypes.POINTERTAP: this.canvasClick(ev.event); break;
                case PointerEventTypes.POINTERMOVE: this.canvasMove(ev.event); break;
                case PointerEventTypes.POINTERDOUBLETAP: this.canvasDblClick(ev.event); break;
            }
        });

        this.onCanvasBlur = this.scene.getEngine().onCanvasPointerOutObservable.add(ev => {
            if (this.lastMesh)
                this.lastMesh.showBoundingBox = false;

            if (this.lastClickedMesh)
                this.lastClickedMesh.showBoundingBox = true;
        });

        this.onCanvasFocus = this.scene.getEngine().onCanvasBlurObservable.add(ev => {
            if (this.lastClickedMesh)
                this.lastClickedMesh.showBoundingBox = false;
            
            if (this.lastMesh)
                this.lastMesh.showBoundingBox = true;
        });
    }

    /**
     * Removes the scene picker events from the canvas
     */
    public removeEvents (): void {
        this.scene.onPointerObservable.remove(this.onCanvasPointer);
        this.scene.getEngine().onCanvasPointerOutObservable.remove(this.onCanvasBlur);
        this.scene.getEngine().onCanvasFocusObservable.remove(this.onCanvasFocus);
    }

    /**
     * Adds undo redo
     * @param delta the delta value (from / to)
     * @param axis the moved axis
     */
    protected undoRedo (axis: 'x' | 'y' | 'z' | 'boundingbox'): void {
        let vector: Vector3 = null;
        switch (this._gizmoType) {
            case GizmoType.POSITION: vector = this.positionGizmo.xGizmo.attachedMesh.position; break;
            case GizmoType.ROTATION: vector = this.rotationGizmo.xGizmo.attachedMesh.rotation; break;
            case GizmoType.SCALING: vector = this.scalingGizmo.xGizmo.attachedMesh.scaling; break;
            default: break;
        }

        switch (axis) {
            case 'x': UndoRedo.Push({ object: vector, property: 'x', from: vector.x - this._gizmoDelta, to: vector.x }); break;
            case 'y': UndoRedo.Push({ object: vector, property: 'y', from: vector.y - this._gizmoDelta, to: vector.y }); break;
            case 'z': UndoRedo.Push({ object: vector, property: 'z', from: vector.z - this._gizmoDelta, to: vector.z }); break;
            case 'boundingbox':
                if (this._gizmoScaleDelta) {
                    const lastScale = this._gizmoScaleDelta.clone();
                    const lastPosition = this._gizmoPositionDelta.clone();
                    
                    const newScale = this.boundingBoxGizmo.attachedMesh.scaling.clone();
                    const newPosition = this.boundingBoxGizmo.attachedMesh.position.clone();

                    UndoRedo.Push({
                        fn: type => {
                            if (type === 'from') {
                                this.boundingBoxGizmo.attachedMesh.scaling = lastScale;
                                this.boundingBoxGizmo.attachedMesh.position = lastPosition;
                            }
                            else {
                                this.boundingBoxGizmo.attachedMesh.scaling = newScale;
                                this.boundingBoxGizmo.attachedMesh.position = newPosition;
                            }
                        }
                    });
                }
                else {
                    const lastRotation = this._gizmoRotationDelta.clone();
                    const newRotation = this.boundingBoxGizmo.attachedMesh.rotationQuaternion.clone();

                    UndoRedo.Push({ object: this.boundingBoxGizmo.attachedMesh, property: 'rotationQuaternion', from: lastRotation, to: newRotation });
                }
                break;
        }

        this._gizmoDelta = 0;
        this._gizmoScaleDelta = null;
        this._gizmoPositionDelta = null;
        this._gizmoRotationDelta = null;
    }

    /**
     * Called when canvas mouse is down
     * @param ev the mouse event
     */
    protected canvasDown(ev: MouseEvent): void {
        this.lastX = ev.offsetX;
        this.lastY = ev.offsetY;
    }

    /**
     * Called when canvas mouse is up
     * @param ev the mouse event
     */
    protected canvasClick (ev: MouseEvent): void {
        if (!this._enabled)
            return;
        
        if (Math.abs(this.lastX - ev.offsetX) > 5 || Math.abs(this.lastY - ev.offsetY) > 5)
            return;
        
        const pick = this.editor.sceneIcons.pickIcon(ev.offsetX, ev.offsetY) || this.scene.pick(ev.offsetX, ev.offsetY);

        if (pick.pickedMesh) {
            if (this.onPickedMesh)
                this.onPickedMesh(pick.pickedMesh);

            // Attach mesh
            this.setGizmoAttachedMesh(<Mesh> pick.pickedMesh);

            // Save last clicked mesh
            this.lastClickedMesh = pick.pickedMesh;
        }
    }

    /**
     * Called when mouse moves on canvas
     * @param ev the mouse event
     */
    protected canvasMove (ev: MouseEvent): void {
        if (!this._enabled)
            return;
        
        if (this.lastMesh)
            this.lastMesh.showBoundingBox = false;

        if (this.lastClickedMesh)
            this.lastClickedMesh.showBoundingBox = false;

        const pick = this.editor.sceneIcons.pickIcon(ev.offsetX, ev.offsetY, false) || this.scene.pick(ev.offsetX, ev.offsetY);
        if (pick.pickedMesh) {
            this.lastMesh = pick.pickedMesh;
            pick.pickedMesh.showBoundingBox = true;
        }
    }

    /**
     * Called when double click on the canvas
     * @param ev: the mouse event
     */
    protected canvasDblClick (ev: MouseEvent): void {
        if (!this._enabled)
            return;
        
        const camera = <TargetCamera> this.scene.activeCamera;
        if (!(camera instanceof TargetCamera))
            return;

        const pick = this.editor.sceneIcons.pickIcon(ev.offsetX, ev.offsetY) || this.scene.pick(ev.offsetX, ev.offsetY);

        if (pick.pickedMesh) {
            ScenePicker.CreateAndPlayFocusAnimation(camera.getTarget(), pick.pickedMesh.getAbsolutePosition(), camera);

            // Save last clicked mesh
            this.lastClickedMesh = pick.pickedMesh;
        }
    }

    /**
     * Creates an starts an animation that targets the given "end" position
     * @param start the start target position
     * @param end the end target position
     * @param camera the camera to animate
     */
    public static CreateAndPlayFocusAnimation (start: Vector3, end: Vector3, camera: Camera): void {
        const anim = new Animation('LockedTargetAnimation', 'target', 60, Animation.ANIMATIONTYPE_VECTOR3);
        anim.setKeys([
            { frame: 0, value: start },
            { frame: 24, value: end },
        ]);

        const scene = camera.getScene();

        scene.stopAnimation(camera);
        scene.beginDirectAnimation(camera, [anim], 0, 24, false, 1.0);
    }
}