import type * as T from 'three';
import type {Pose,V3} from './math';
export interface Annotation{text:string;position:V3;size?:number;color?:string;dx?:number;dy?:number;line?:boolean;}
export interface View{pose:Pose;notes?:Annotation[];tag?:string;light?:boolean;title?:string;}
export interface Rig{root:T.Group;update(i:number,u:number,t:number):View;}
