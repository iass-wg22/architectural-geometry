# IASS Design Guide for Architectural Engineering of surfaces

<!-- BANDEAU D’INTRODUCTION DE LA PAGE D’ACCUEIL -->
:::{admonition} Aims and scope
This design guide is a collaborative project driven by Working Group 22 of the International Association for Shell and Spatial Structures [IASS](https://iass-structures.org/WG22-Public). It aims at spreading the knowledge of Architectural Geometry within the community interested in architectural design of surfaces. It is thus structured so as to help architects and engineers in their design process and relies therefore on the Structural Morphology Framework (defined by Motro et al.). 
:::

:::{dropdown} About the Structural Morpology Framework
Within the IASS, this framework described the design of a structure as a compromise between five categories of parameters: form, force, structure, material and technology. Each category regroups a typical set of parameters used to describe the structure:

* The **Form**  parameters define the shape;
* The **Force** parameters define the forces applied to the shape and the forces within it;
* The **Structure** parameters define the topology of the members constituting the shape, their nature and their relation;
* The **Material** parameters define the material of the various members;
* The **Technology** parameters define technological aspects of the construction, from assembly to erection process. 

Each design is hence seen as a compromise between the five sets, each design process as the order in which the various parameters are taken into account.
:::

:::{dropdown} About the structure of the design guide
Architectural Geometry is not solely geometry. It contains a lot of mathematical notions but it combines them with other architectural intents. Depending on which intent the designer gives more importance first, one will get a different design process. Elementary interactions of the form parameters with the other categories constitute hence the core structure of this design guide. Beside an ordered presentation of remarkable famillies of surfaces, each section contains also associated numerical methods to transform, compose, assemble or form-find complex shapes. 

1. **Describing the shape** introduces the various notions of geometry which are necessary for a designer to describe and analyse a *form*.
2. **Structuring globally the shape** focuses on the *form-structure interaction* and contains all the shapes which comes with a natural structuration or discretisation with remarkable architectural features; they are classified by shape generation methods.
3. **Translating locally technology into shape** focuses on the *form-technology interaction* and contains geometrical interpretations of technological features (in terms of member or assembly caracteristics). Methods to agregate these locally defined properties into a global shape are also described here. 
4. **Starting from equilibrium** focuses on the *form-force interaction* and emphasises shapes which have naturally good mechanical properties, which can withstand loads with minimal deformation such as funicular, self-stressed and inflatable structures. References of form-finding methods are also listed here. 

More complex interactions are of course possible, but they are likely less general. They will thus be illustrated in the section dedicated to case studies.

5. **Built examples** contains thus analyses of existing remarkable built examples through the prism of interaction between form, force, structure, material and technology. They are classified by *material*, which is the only category of parameters which is not adressed elsewhere.
:::

::::{card} 
:header: **Describing the shape**
[This section](.\form\home_portal.md) provides a short and targeted introduction to the various notions of geometry which are necessary for a designer to describe and analyse a *form*.

:::{dropdown} [Geometry of Curves](.\form\curves\home.md)
Elementary notions of curves geometry: Local frame (Frenet, Bishop), osculating plane, curvature and torsion, paralel transport, etc.
:::

:::{dropdown} [Geometry of Smooth Surfaces](.\form\smooth_surfaces\home.md)
Elementary notions of smooth differential geometry: parametrisation, metric change and first fundamental form, curvature and second fundamental form, Gauss Map, geometry of curves on surface (Darboux frame, geodesic curves, principal curvarture, asymptotic curves), curve networks (conjugate), developability, singularity, etc.
:::

:::{dropdown} [Geometry of Polyedral Surfaces](.\form\polyedral_surfaces\home.md)  
Elementary notions of discrete differential geometry: curvature of a polyedral surface, Gauss Map, elementary mesh topology/Morphologies (Tri, Quad, Hex and singularities), PQ Mesh, circular and conical meshes, PHex-Mesh, geodesic, etc. 
:::

:::{dropdown} [Transformations of Surfaces](.\form\transformations\home.md )
Transformations play a central role in the understanding and structuration of geometry. A few meaningfull transformations for architecture are recalled here: isometry, Möbius transform (or inversion), Combescure transform (or parallelism), Affine transformation, etc. Basically, transformations allow the designer to deal with famillies of shapes with remarkable properties rather than with single shapes.
:::

::::

::::{card} 
:header: **Starting from shape generation methods**

The starting points of this section are the shape generation methods, which basically implies that the designer looks for a global structuration of the surface, a natural and remarkable parametrisation/discretisation. It can be seen as an exploration of the design space through the interaction between the form and structure parameters.

:::{dropdown} Surfaces from 2 curves
This section contains surfaces generated by two curves ordered by characteristics of the resulting mesh.

{button}`Meshed by principal curvatures <form_structure/2curves/principal/home.md>`
{button}`Meshed by asymptotic curves <form_structure/2curves/asymptotic/home.md>`
{button}`Meshed by geodesic curves <form_structure/2curves/geodesic/home.md>`
{button}`Meshed by planar quads <form_structure/2curves/planar_quads/home.md>`  

:::

:::{dropdown} Surfaces from 3 curves
This section contains surfaces generated by three curves ordered by characteristics of the resulting mesh.

{button}`Meshed by principal curvatures <form_structure/3curves/principal/home.md>`
{button}`Meshed by asymptotic lines <form_structure/3curves/asymptotic/home.md>`

:::

::::

::::{card} 
:header: **Starting from from building technology**
The starting point of [this section](.\form_technology\home_portal.md) is the building technology, which basically implies that the designer looks for a specific technology and would like to know how it translates geometrically and what shapes can be suitable. It can be seen as an exploration of the design space through the interaction between the form and technology parameters.

:::{dropdown}  [By member characteristics](.\form_technology\member_characteristics\home.md)
This section lists usual member characteristics and translates them into local geometric properties.
:::

:::{dropdown}   [By node characteristics](.\form_technology\Node_characteristics\home.md)
This section lists usual node/assembly characteristics and translates them into local geometric properties.
:::

:::{dropdown}  [By panel characteristics](.\form_technology\Panel_characteristics\home.md)
This section lists usual panel characteristics and translates them into local geometric properties.
:::

:::{dropdown}  [Integration methods](.\form_technology\Integration_methods\home.md)
This section provides an overview of numerical methods to integrate local geometric properties and the scale of the global shape.
:::


::::

::::{card}
:header: **Starting from equilibrium and mechanical behaviour**
The starting point of [this section](.\form_force\home_portal.md) is equilibrium, which basically implies that the designer looks for a shape with an optimal behaviour under a specific loading. It can be seen as an exploration of the design space through the interaction between the form and force parameters.

:::{dropdown}  [Geometry and equilibrium](.\form_force\equilibrium\home.md)
This section recalls basic notions of equilibrium of usual mechanical models from arch to membrane through Pucher, Laplace equations as well as static graphics.
:::

:::{dropdown} [Inflatable shapes](.\form_force\inflatable\home.md)
This section reviews shapes which are naturally in equilibrium with a uniform pressure.
:::

:::{dropdown} [Funicular shapes](.\form_force\funicular\home.md)
This section reviews shapes which are naturally in equilibrium with gravity loads.

:::

:::{dropdown} [Self-stressed shapes](.\form_force\self_stressed\home.md)
This section reviews shapes in which one or several self-stressed states exist.

:::

:::{dropdown} [Form-finding methods](.\form_force\form_finding\home.md)
This section expands previous notions to methods commonly used to search for shapes in equilibrium.

:::

::::

::::{card}
:header: **Remarkable Built Examples**
This section contains analyses of remarkable built examples through the prism of interaction between form, force, structure, material and technology. They are classified by *material*, which is the only category of parameters which is not adressed elsewhere.

:::{dropdown} Made of timber
This section regroups built examples where timber is the dominant material.

:::

:::{dropdown} Made of steel
This section regroups built examples where steel is the dominant material.

:::

:::{dropdown} Made of concrete
This section regroups built examples where concrete is the dominant material.

:::

:::{dropdown} Made of stone
This section regroups built examples where stone is the dominant material.

:::

:::{dropdown} Made of textile
This section regroups built examples where textile is the dominant material.

:::

::::


:::::{card}
:header: **Index**
This section contains usueful indexes by alphetical order. 

::::{dropdown} Surfaces
:open:
Here is a list of surfaces with remarkable architectural properties which relate to shape generation, building technology or equilibrium.
:::{dropdown} A-D
*no surfaces here yet*

:::

:::{dropdown} E-H
:open:
{button}`Hyperbolic Paraboloid <surfaces/hyperbolic_paraboloid/home.md>`

:::

:::{dropdown} I-L
*no surfaces here yet*

:::

:::{dropdown} M-P
:open:
{button}`Moulding surfaces <surfaces/moulding_surfaces/home.md>`

:::


:::{dropdown} Q-T
*no surfaces here yet*

:::

:::{dropdown} U-Z
*no surfaces here yet*

:::

::::


:::::